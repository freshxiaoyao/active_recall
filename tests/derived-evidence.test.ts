import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeVerificationEpisodes } from "../derived-evidence.js";
import { hydrateWikiExcerpts } from "../wiki-excerpts.js";
import { fuseRoutes } from "../fusion.js";

test("truncated Wiki previews recover the matching indexed range and Chinese query detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "recall-wiki-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(join(root, "wiki"));
    const prefix = "---\npageType: source\n---\n# Design\n- Integration test for flood detector.\n";
    await writeFile(join(root, "wiki", "design.md"), prefix + "- flood detector 60s/8 次阈值需观察。\nNEIGHBOR MUST NOT BE READ\n");
    const result = { hits: [{path:"../wiki/design.md",line:1,endLine:6,score:.8,snippet:prefix.slice(0,-4),source:"memory"}], timing:{spawnMs:0,searchMs:1,totalMs:1},rawOutput:"" };
    const hydrated = await hydrateWikiExcerpts(result, workspace);
    assert.match(hydrated.hits[0].snippet, /60s\/8/);
    assert.doesNotMatch(hydrated.hits[0].snippet, /NEIGHBOR/);
    const fused = fuseRoutes([{route:"literal",weight:1,result:hydrated}], {query:"flood detector 的阈值和时间窗口",k:20,preferSources:{memory:1},snippetChars:200,topK:1});
    assert.equal(fused[0].line,6);
    assert.match(fused[0].snippet, /^- flood detector 60s\/8/);
    assert.equal(fused[0].bestRawScore,.8);
    await writeFile(join(root,"wiki","design.md"),"Changed source\n" + prefix);
    assert.equal((await hydrateWikiExcerpts(result,workspace)).hits.length,0,"mismatched previews are not trusted");
    await writeFile(join(root,"wiki","design.md"),"x".repeat(256*1024+1));
    assert.equal((await hydrateWikiExcerpts(result,workspace)).hits.length,0,"oversized source is excluded");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("body-only search hits from stored verification episodes are excluded without deleting data", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "recall-derived-"));
  try {
    const dir = "memory/episodes";
    await mkdir(join(workspace, dir), { recursive: true });
    await writeFile(join(workspace,dir,"probe.md"), "- Session: agent:main:probe-old\n\n## Summary\nDerived answer.");
    await writeFile(join(workspace,dir,"user.md"), "- Session: agent:main:user\n\n## Summary\nOriginal decision.");
    const result = await excludeVerificationEpisodes({
      hits: ["probe.md","user.md","missing.md"].map(name=>({path:`${dir}/${name}`,score:.9,snippet:"Only the body, no session header.",source:"memory"})),
      timing:{spawnMs:0,searchMs:1,totalMs:1},rawOutput:"",
    },workspace,dir);
    assert.deepEqual(result.hits.map(hit=>hit.path),[`${dir}/user.md`]);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});
