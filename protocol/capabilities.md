# The capability protocol

**How Ito's server runs a capability.** A capability is anything you switch on: a domain of your
life, such as Time, or a hand, such as Reports. The server starts each capability that's on as its
own Node process and talks to it over standard input and output. Each capability holds only its
own setup values and secrets, and works in its own folder under `ITO_HOME`.

[capability.schema.json](capability.schema.json) defines every message. The server and a
capability must speak the same `0.MINOR`, which is 0.1 for now. The SDK in
[ito-capabilities](https://github.com/akai-ito/ito-capabilities) implements a capability's half,
and the server installs that package with itself, pinned to an exact commit.

## Messages

JSON-RPC 2.0, one JSON object per line, leaving out the `jsonrpc` member as Codex's app server does.
Standard error is the capability's log.

| From | Message | What it does |
| --- | --- | --- |
| server | `initialize` | Asks for the manifest: title, summary, setup fields, operations, skill, and the hosts and folders it uses |
| server | `start` | Hands over its setup values, its folder and the server's versions once it's on and set up; an error means it needs you |
| server | `check` | Tests setup values before they're saved (*Test connection*) |
| server | `call` | Runs an operation for the agent, with the turn it's in |
| server | `cancel` | Gives up on a `call`, by its request id |
| capability | `status` | Says it's working, or that it needs you and why |

A capability exits when its standard input closes, so nothing outlives the server, even after a
`kill -9`.

## What the server does with it

- **Settings.** A capability is *off*, waiting for *setup*, *on*, or *needs you*. It needs you when
  `start` fails, when it says so, or when it crashes five times in ten minutes; until then a crash
  restarts it after a pause that doubles from one second.
- **The agent.** Every operation is a command, `ito <capability> <operation>`, and an operation
  with `tool` is also one of the agent's tools. Both go through the server, so a capability that's
  off is refused at once.

## An exchange

```jsonl
{"id":1,"method":"initialize","params":{"protocol":"0.1"}}
{"id":1,"result":{"protocol":"0.1","manifest":{"id":"echo","version":"0.1","kind":"hand","title":"Echo","summary":"Says back what it's given.","setup":[{"name":"token","kind":"secret","title":"Token"}],"operations":[{"name":"say","title":"Say something back","running":"Echoing","done":"Echoed","description":"Says the text back.","input":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]},"tool":"echo_say"}],"skill":"Use echo to hear yourself.","uses":{"hosts":[],"folders":[]}}}}
{"id":2,"method":"start","params":{"values":{"token":"a-secret"},"folder":"/home/you/.ito/capabilities/echo","server":{"version":"0.6.0","engine":"Codex 0.164.0"}}}
{"id":2,"result":{}}
{"id":3,"method":"call","params":{"operation":"say","input":{"text":"hello"},"turn":"turn_01"}}
{"id":3,"result":{"text":"hello"}}
{"method":"status","params":{"state":"needs_you","detail":"The token stopped working."}}
```
