import test from "node:test";
import assert from "node:assert/strict";
import { RpcProcess, rpcErrorMessage } from "../src/core/rpc.mjs";

test("RPC errors keep the JSON-RPC reason without echoing rejected values", () => {
  assert.equal(
    rpcErrorMessage({
      message: "Invalid params",
      data: { message: 'Session "abc" not found' },
    }),
    'Invalid params: Session "abc" not found',
  );
  assert.equal(
    rpcErrorMessage({
      message: "Invalid params",
      data: {
        _errors: [],
        mcpServers: { _errors: ["Invalid input"], value: "secret-token" },
      },
    }),
    "Invalid params: mcpServers: Invalid input",
  );
  assert.equal(rpcErrorMessage({}), "Agent request failed");
  assert.equal(
    rpcErrorMessage({ message: "Invalid params: already explained" }),
    "Invalid params: already explained",
  );
});

test("RPC correlates out-of-order replies, handles fragmented UTF-8 messages, and rejects pending calls on exit", async () => {
  const code = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='exit'){process.exit(1);}else if(m.method==='hang'){}else{setTimeout(()=>process.stdout.write(JSON.stringify({id:m.id,result:m.params})+'\\n'),m.params.delay||0);}}});`;
  const rpc = new RpcProcess(process.execPath, ["-e", code]);
  try {
    const results = await Promise.all([
      rpc.call("echo", { text: "café", delay: 30 }),
      rpc.call("echo", { text: "fast" }),
    ]);
    assert.equal(results[0].text, "café");
    assert.equal(results[1].text, "fast");
    const pending = rpc.call("hang", {}, 5000);
    rpc.notify("exit");
    await assert.rejects(pending, /exited/);
  } finally {
    rpc.close();
  }
});
test("timed out RPC requests are not automatically retried", async () => {
  const rpc = new RpcProcess(process.execPath, [
    "-e",
    "process.stdin.resume()",
  ]);
  try {
    await assert.rejects(rpc.call("no-retry", {}, 30), /not retried/);
    assert.equal(rpc.pending.size, 0);
  } finally {
    rpc.close();
  }
});
