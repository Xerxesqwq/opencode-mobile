// Run with: node scripts/generate-launcher-icons.mjs
// Keep the mark inside Android's 66/108 adaptive-icon safe zone.
import sharp from "sharp"
import { mkdir, writeFile } from "node:fs/promises"

const res = new URL("../android/app/src/main/res/", import.meta.url)
const assets = new URL("../assets/", import.meta.url)
const background = "#0F172A"
const paths = [
  { d: "M43 36 L27 52 L43 68", color: "#F8FAFC" },
  { d: "M65 36 L81 52 L65 68", color: "#38BDF8" },
  { d: "M49 73 L59 73", color: "#38BDF8" },
]
function svg(bg = false, mono = false) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">${bg ? `<rect width="108" height="108" fill="${background}"/>` : ""}${paths.map(p => `<path d="${p.d}" fill="none" stroke="${mono ? "#FFFFFF" : p.color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}</svg>`
}
async function png(source, size, destination) {
  await sharp(Buffer.from(source)).resize(size, size).png().toFile(destination)
}
await writeFile(new URL("icon.svg", assets), svg(true))
await png(svg(true), 1024, new URL("icon.png", assets).pathname)
await png(svg(), 1024, new URL("adaptive-icon.png", assets).pathname)
await png(svg(false, true), 1024, new URL("monochrome-icon.png", assets).pathname)
await png(svg(), 1024, new URL("splash-icon.png", assets).pathname)
await png(svg(false, true), 96, new URL("notification-icon.png", assets).pathname)

for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  await png(svg(), size * 6, new URL(`drawable-${density}/splashscreen_logo.png`, res).pathname)
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    const mask = `<svg width="${size}" height="${size}"><${name.endsWith("round") ? `circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"` : `rect width="${size}" height="${size}" rx="${size * 0.22}"`} fill="white"/></svg>`
    await sharp(Buffer.from(svg(true))).resize(size, size)
      .composite([{ input: Buffer.from(mask), blend: "dest-in" }])
      .webp({ lossless: true }).toFile(new URL(`mipmap-${density}/${name}.webp`, res).pathname)
  }
}
for (const [name, mono] of [["ic_launcher_foreground", false], ["ic_launcher_monochrome", true]]) {
  await writeFile(new URL(`drawable/${name}.xml`, res), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n${paths.map(p => `  <path android:pathData="${p.d}" android:strokeColor="${mono ? "#FFFFFF" : p.color}" android:strokeWidth="6" android:strokeLineCap="round" android:strokeLineJoin="round"/>`).join("\n")}\n</vector>\n`)
}
await writeFile(new URL("drawable/ic_launcher_background.xml", res), `<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle"><solid android:color="${background}"/></shape>\n`)
for (const version of [26, 33]) {
  await mkdir(new URL(`mipmap-anydpi-v${version}/`, res), { recursive: true })
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    await writeFile(new URL(`mipmap-anydpi-v${version}/${name}.xml`, res), `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@drawable/ic_launcher_background"/>\n  <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n${version === 33 ? '  <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n' : ""}</adaptive-icon>\n`)
  }
}
