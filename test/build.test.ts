import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPatch, readPatch, storePatch, finishPatch, commandReceipts } from "../src/build.ts";
import { digestOf } from "../src/run.ts";

function fixture(t: { after(fn: () => void): void }) {
 const root = mkdtempSync(join(tmpdir(), "factory-build-"));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 for (const name of ["base", "work", "store"]) mkdirSync(join(root, name), { mode: 0o700 });
 return { root, base: join(root, "base"), workspace: join(root, "work"), stateDir: join(root, "store") };
}

test("collects deterministic exact bytes, deletions, binary files and executable modes", async t => {
 const f = fixture(t);
 for (const dir of [f.base, f.workspace]) writeFileSync(join(dir,"same"),"one\n");
 writeFileSync(join(f.base,"removed"),"old\n");
 writeFileSync(join(f.workspace,"added"),Buffer.from([0, 1, 2]));
 chmodSync(join(f.workspace,"same"),0o755);
 const first = await collectPatch(f);
 const second = await collectPatch(f);
 assert.equal(first.kind,"collected"); assert.deepEqual(second, first);
 if(first.kind !== "collected") return;
 assert.deepEqual(first.changedPaths,["added","removed","same"]);
 assert.equal(first.patchDigest,digestOf(first.patch));
 assert.match(first.patch,/GIT binary patch/);
 assert.match(first.patch,/old mode 100644\nnew mode 100755/);
});

test("rejects empty patches and records both sides of forbidden renames", async t => {
 const f = fixture(t);
 assert.deepEqual(await collectPatch(f),{kind:"error",reason:"empty_patch"});
 writeFileSync(join(f.base,"original"),"code\n");
 mkdirSync(join(f.workspace,"test/acceptance"),{recursive:true});
 writeFileSync(join(f.workspace,"test/acceptance/moved"),"code\n");
 const result = await collectPatch(f);
 assert.equal(result.kind,"collected");
 if(result.kind !== "collected") return;
 assert.equal(result.policy,"forbidden");
 assert.deepEqual(result.changedPaths,["original","test/acceptance/moved"]);
 assert.ok(result.patch.length > 0);
});

test("rejects escaping symlinks including physical dot-component chains", async t => {
 const f = fixture(t);
 symlinkSync(".",join(f.workspace,"d"));
 symlinkSync("d/..",join(f.workspace,"e"));
 symlinkSync("e/..",join(f.workspace,"f"));
 assert.deepEqual(await collectPatch(f),{kind:"error",reason:"unsafe_symlink"});
});

test("collects safe symlinks without following them", async t => {
 const f = fixture(t);
 writeFileSync(join(f.workspace,"target"),"hello\n");
 symlinkSync("target",join(f.workspace,"link"));
 const result = await collectPatch(f);
 assert.equal(result.kind,"collected");
 if(result.kind !== "collected") return;
 assert.deepEqual(result.changedPaths,["link","target"]);
 assert.match(result.patch,/120000/);
});

test("private collection survives restart, retains test failures, never regenerates damaged bytes", async t => {
 const f = fixture(t);
 writeFileSync(join(f.workspace,"test.js"),"bad\n");
 const patch = await collectPatch(f);
 assert.equal(patch.kind,"collected");
 if(patch.kind !== "collected") return;
 const binding = {runId:digestOf("run"), baseSha:"a".repeat(40), contractDigest:digestOf("contract"), acceptanceDigest:digestOf("suite")};
 const stored = storePatch(f.stateDir,binding,patch,{model:"openai/gpt-6.1-sol",observed:null,commands:[]});
 assert.equal(stored.kind,"found");
 const failed = finishPatch(f.stateDir,binding,{command:"npm test",exitCode:1,tail:"FAILED",wallMs:1});
 assert.equal(failed.kind,"found");
 if(failed.kind !== "found") return;
 assert.equal(failed.receipt.visibleTests?.exitCode,1);
 finishPatch(f.stateDir,binding,{command:"npm test",exitCode:0,tail:"ok",wallMs:1});
 assert.deepEqual(readPatch(f.stateDir,binding),failed);
 const path=join(f.stateDir,"patches",binding.runId,"patch.diff");
 assert.equal(readFileSync(path,"utf8"),patch.patch);
 writeFileSync(path,"changed");
 assert.deepEqual(readPatch(f.stateDir,binding),{kind:"blocked",reason:"patch_changed"});
 rmSync(path);
 assert.deepEqual(readPatch(f.stateDir,binding),{kind:"blocked",reason:"patch_missing"});
 assert.equal(storePatch(f.stateDir,binding,patch,{model:"x",observed:null,commands:[]}).kind,"blocked");
});

test("command receipts use tool calls and results rather than final prose", () => {
 const session = [
 {type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"1",name:"bash",arguments:{command:"npm test"}}]}},
 {type:"message",message:{role:"toolResult",toolCallId:"1",toolName:"bash",content:[{type:"text",text:"fail\n\nCommand exited with code 1"}],isError:true}},
 {type:"message",message:{role:"assistant",content:[{type:"text",text:"npm test passed"}]}},
 ].map(x=>JSON.stringify(x)).join("\n");
 assert.deepEqual(commandReceipts(session),[{command:"npm test",exitCode:1}]);
});
