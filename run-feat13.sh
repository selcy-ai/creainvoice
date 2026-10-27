#!/bin/bash
set -u
cd /root/workspaces/agent-build/creainvoice
M="omniroute/intern-ai/Atria-Dawn"
P=".opencode-prompt-feat13-r3.txt"
$HOME/.opencode/bin/opencode run "$(cat "$P")" --model "$M" --standalone --title "feat-13-creainvoice-r3" > /tmp/opencode-feat13-r3.log 2>&1
echo "EXIT=$?" >> /tmp/opencode-feat13-r3.log
