/**
 * `CliCommandDefinition.options` used to be decoration — declared by plugins, ignored
 * by `embody run`, which only accepted one `--options '<json>'` blob. These tests pin
 * the parser that makes the declarations real, including the failure the JSON blob
 * could never produce: a typo'd flag being rejected rather than silently dropped.
 */
import { describe, it, expect } from "vitest";
import type { CliCommandDefinition } from "@embody/kernel";
import { parsePluginTail, tailAfterCommand } from "./plugin-options.ts";

const def = (options: CliCommandDefinition["options"] = []): CliCommandDefinition => ({
  name: "automation:create",
  description: "",
  options,
  handler: () => undefined,
});

const create = def([
  { flags: "--when <event>", description: "" },
  { flags: "--if <condition...>", description: "" },
  { flags: "--do <tool>", description: "" },
  { flags: "--failed", description: "" },
  { flags: "--limit <n>", description: "", defaultValue: "50" },
  { flags: "--run-as <roles>", description: "" },
]);

describe("parsePluginTail", () => {
  it("reads value options", () => {
    expect(parsePluginTail(create, ["--when", "crm.deal.created", "--do", "x"]).options).toEqual({
      when: "crm.deal.created",
      do: "x",
      limit: "50",
    });
  });

  it("reads boolean flags", () => {
    expect(parsePluginTail(create, ["--failed"]).options.failed).toBe(true);
  });

  it("accepts --flag=value", () => {
    expect(parsePluginTail(create, ["--when=crm.deal.created"]).options.when).toBe(
      "crm.deal.created",
    );
  });

  it("collects a variadic option and accumulates repeats", () => {
    // `--if 'a > 1' --if 'b < 2'` is how conditions are ANDed.
    const { options } = parsePluginTail(create, [
      "--if",
      "payload.amount > 50000",
      "--if",
      "payload.stage == lead",
    ]);
    expect(options.if).toEqual(["payload.amount > 50000", "payload.stage == lead"]);
  });

  it("does not let a variadic swallow the next flag", () => {
    const { options } = parsePluginTail(create, ["--if", "a > 1", "--do", "tool"]);
    expect(options.if).toEqual(["a > 1"]);
    expect(options.do).toBe("tool");
  });

  it("camelCases a hyphenated long name, as Commander would", () => {
    expect(parsePluginTail(create, ["--run-as", "member"]).options.runAs).toBe("member");
  });

  it("applies declared defaults", () => {
    expect(parsePluginTail(create, []).options).toEqual({ limit: "50" });
  });

  it("keeps positional arguments", () => {
    const withArgs: CliCommandDefinition = { ...def([{ flags: "--x <v>", description: "" }]) };
    const { args, options } = parsePluginTail(withArgs, ["deal-123", "--x", "1"]);
    expect(args).toEqual(["deal-123"]);
    expect(options).toEqual({ x: "1" });
  });

  it("rejects an unknown flag instead of dropping it", () => {
    // A typo'd `--wehn` that quietly creates a workflow with no trigger is worse than
    // a failed command.
    expect(() => parsePluginTail(create, ["--wehn", "x"])).toThrow(/Unknown option "--wehn"/);
  });

  it("says so when a command declares no options at all", () => {
    expect(() => parsePluginTail(def(), ["--any"])).toThrow(/declares no options/);
  });

  it("rejects a value option with nothing after it", () => {
    expect(() => parsePluginTail(create, ["--when"])).toThrow(/needs a value/);
  });
});

describe("tailAfterCommand", () => {
  const argv = ["node", "embody", "run", "automation:create", "--when", "x", "--do", "y"];

  it("returns everything after the command name", () => {
    expect(tailAfterCommand(argv, "automation:create")).toEqual(["--when", "x", "--do", "y"]);
  });

  it("strips run's own --options so it is not read as a plugin flag", () => {
    const withJson = ["node", "embody", "run", "c", "--options", '{"a":1}', "--when", "x"];
    expect(tailAfterCommand(withJson, "c")).toEqual(["--when", "x"]);
  });

  it("returns nothing when the command is absent", () => {
    expect(tailAfterCommand(["node", "embody", "tools"], "automation:create")).toEqual([]);
  });

  it("does not mistake an argument that repeats the command name", () => {
    // `embody run automation:create --name automation:create` — the tail starts after
    // the FIRST occurrence following `run`.
    const dupe = ["node", "embody", "run", "c", "--name", "c"];
    expect(tailAfterCommand(dupe, "c")).toEqual(["--name", "c"]);
  });
});
