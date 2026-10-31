---
name: baton
description: Bridge OpenClaw lifecycle events into Baton shared memory.
metadata:
  openclaw:
    events:
      - agent:bootstrap
      - command:new
      - command:reset
      - session:compact:before
      - session:compact:after
      - message:sent
      - gateway:shutdown
    requires:
      bins:
        - baton
---

# Baton

Captures OpenClaw lifecycle events into the local Baton memory layer and can inject relevant workspace context during agent bootstrap.
