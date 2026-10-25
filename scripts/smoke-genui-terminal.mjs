import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

// Real Pi CLI, OS pseudo-terminal, public extension/custom UI APIs, and injected
// boundary dispatcher. The authenticated real-Kanban proof is a separate suite.
const packageRoot = new URL(
  "../packages/genui-pi/node_modules/@earendil-works/pi-coding-agent/",
  import.meta.url,
);
const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
const cli = new URL(manifest.bin.pi, packageRoot);
const temporary = mkdtempSync(join(tmpdir(), "genui-terminal-"));
const nativeUrl = new URL("../packages/genui-pi/dist/native.js", import.meta.url).href;
const controllerUrl = new URL("../packages/genui/dist/controller.js", import.meta.url).href;
const results = [];
try {
  const fixture = join(temporary, "fixture.mjs");
  writeFileSync(
    fixture,
    `
import { writeFileSync } from "node:fs";
import { createPiGenUiComponent } from ${JSON.stringify(nativeUrl)};
import { createGenUiController } from ${JSON.stringify(controllerUrl)};
export default function(pi) {
  pi.registerCommand("genui-terminal", { description: "Local terminal smoke", handler: async (_args, ctx) => {
    if (ctx.mode !== "tui") throw new Error("Expected actual TUI mode");
    const outcomes=[];
    const state=() => writeFileSync(process.env.GENUI_TERMINAL_STATE, JSON.stringify({ready:true,outcomes}));
    const change={intent:"change",schema:{type:"object",additionalProperties:false,properties:{value:{type:"string",maxLength:80}},required:["value"]}};
    const document={version:1,root:{version:1,type:"section",title:"Terminal task",children:[{version:1,type:"form",id:"save",label:"Update task",effect:"Change task",children:[{version:1,type:"field",id:"pr",label:"PR",value:"",sensitive:true,event:change}],event:{intent:"submit",target:"cards.update",schema:{type:"object",additionalProperties:false,properties:{pr:{type:"string",maxLength:80}},required:["pr"]}}}]}};
    let mutation=0;
    const controller=createGenUiController({document,callableTargets:["cards.get","cards.update"],readTargets:["cards.get"],refresh:{target:"cards.get",input:{}},resolveAction:(_id,values)=>({pr:values.pr}),present:()=>document,dispatch:async(target)=>{if(target==="cards.update" && ++mutation===1)throw Object.assign(new Error("private cause"),{code:"HOOK_VETO"});return {};}});
    await ctx.ui.custom((tui,theme,kb,done)=>{
      const component=createPiGenUiComponent({controller,requestRender:()=>tui.requestRender(),onClose:()=>done(),style:(role,text)=>theme.fg(role,text),matches:(data,action)=>kb.matches(data,action),publishOutcome:async(outcome)=>{outcomes.push(outcome);state();}});
      state();return component;
    });
    writeFileSync(process.env.GENUI_TERMINAL_STATE,JSON.stringify({ready:true,outcomes,closed:true}));
    ctx.shutdown();
  }});
}
`,
  );
  const driver = String.raw`
import os, pty, subprocess, select, time, json, struct, fcntl, termios, signal, sys
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 80, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, cwd=os.environ['PI_CODING_AGENT_DIR'], close_fds=True)
os.close(slave)
output = bytearray()
def wait(predicate):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        ready,_,_=select.select([master],[],[],0.05)
        if ready:
            try: output.extend(os.read(master,65536))
            except OSError: pass
        try:
            with open(os.environ['GENUI_TERMINAL_STATE']) as file: state=json.load(file)
            if predicate(state): return state
        except (FileNotFoundError,json.JSONDecodeError): pass
        if child.poll() is not None: raise RuntimeError('Pi exited before terminal assertion: '+output.decode(errors='replace')[-3000:])
    raise RuntimeError('Terminal assertion timed out: '+output.decode(errors='replace')[-3000:])
try:
    wait(lambda state: state.get('ready'))
    os.write(master,b'private-terminal-draft\t\r')
    wait(lambda state: len(state.get('outcomes',[]))==1)
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',40,30,0,0))
    child.send_signal(signal.SIGWINCH)
    os.write(master,b'\r')
    wait(lambda state: len(state.get('outcomes',[]))==2)
    os.write(master,b'\x1b')
    state=wait(lambda state: state.get('closed'))
    deadline=time.monotonic()+10
    while child.poll() is None and time.monotonic()<deadline:
        ready,_,_=select.select([master],[],[],0.05)
        if ready:
            try: output.extend(os.read(master,65536))
            except OSError: pass
    child.wait(timeout=1)
    assert child.returncode==0, child.returncode
    assert b'private-terminal-draft' not in output, 'Sensitive draft leaked to terminal'
    assert b'Terminal task' in output, 'No actual terminal render'
    print(json.dumps(state))
finally:
    if child.poll() is None: child.kill(); child.wait(timeout=10)
    os.close(master)
`;
  for (const [mode, theme] of [
    ["fullscreen", "dark"],
    ["regular", "light"],
  ]) {
    const agentDir = join(temporary, mode);
    mkdirSync(agentDir);
    const state = join(agentDir, "state.json");
    execFileSync(
      "python3",
      [
        "-c",
        driver,
        process.execPath,
        cli.pathname,
        "--offline",
        "--no-approve",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-tools",
        "--extension",
        fixture,
        "--tui-mode",
        mode,
        "--use-theme",
        theme,
        "/genui-terminal",
      ],
      {
        timeout: 60000,
        env: {
          PATH: process.env.PATH,
          HOME: agentDir,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          GENUI_TERMINAL_STATE: state,
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const observed = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(observed.closed, true);
    assert.deepEqual(
      observed.outcomes.map((value) => value.status),
      ["rejected", "confirmed"],
    );
    assert.equal(observed.outcomes[0].code, "HOOK_VETO");
    results.push({
      mode,
      theme,
      resizeColumns: "80 → 30",
      keyboardVetoCorrection: "passed",
      sensitiveDraft: "hidden",
      shutdown: "passed",
    });
  }
  const evidence = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    pi: "1.0.0",
    terminal: "OS PTY / xterm-256color, not physical terminal or screen-reader certification",
    results,
  };
  const output = new URL(process.argv[2] ?? "../artifacts/genui/terminal.json", import.meta.url);
  mkdirSync(new URL(".", output), { recursive: true });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
