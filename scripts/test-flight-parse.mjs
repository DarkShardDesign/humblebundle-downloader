import fs from "node:fs";

const html = fs.readFileSync(process.argv[2], "utf8");

const markers = [
  /\\"title\\":\\"([^"\\]+)\\",\\"type\\":\\"download_drm_free\\",\\"redemptionData\\":\{\},\\"downloads\\":\[\{/g,
  /"id":"[0-9a-f-]{36}","title":"([^"]+)","type":"download_drm_free","redemptionData":\{\},"downloads":\[\{/g,
];

function parseChunk(chunk) {
  const key =
    chunk.match(/\\"key\\":\\"([^"\\]+)\\"/)?.[1] ??
    chunk.match(/"key":"([^"]+)"/)?.[1];
  const platform = (
    chunk.match(/\\"platform\\":\\"([^"\\]+)\\"/)?.[1] ??
    chunk.match(/"platform":"([^"]+)"/)?.[1] ??
    ""
  ).toLowerCase();
  const struct =
    chunk.match(/\\"downloadStruct\\":\[([\s\S]*?)\],\\"updatedAt\\"/)?.[1] ??
    chunk.match(/"downloadStruct":\[([\s\S]*?)\],"updatedAt"/)?.[1] ??
    "";
  const webs = [...struct.matchAll(/\\"web\\":\\"([^"\\]+)\\"|"web":"([^"]+)"/g)].map(
    (x) => x[1] || x[2],
  );
  return { key, platform, webs };
}

for (const [i, re] of markers.entries()) {
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    hits.push({ title: m[1], end: re.lastIndex });
  }
  let files = 0;
  for (let j = 0; j < hits.length; j++) {
    const start = hits[j].end;
    const stop = hits[j + 1] ? hits[j + 1].end - 200 : start + 12_000;
    const chunk = html.slice(start, stop);
    const parsed = parseChunk(chunk);
    files += parsed.webs.length;
    if (hits[j].title.includes("Building")) {
      console.log("marker", i, hits[j].title, parsed);
    }
  }
  console.log("marker", i, "blocks", hits.length, "files", files);
}