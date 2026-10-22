# -*- coding: utf-8 -*-
# PROTOTYPE 一次性脚本：向 ZCode config.json 注入 hook 后自删
import json

P = 'C:/Users/86176/.zcode/cli/config.json'
with open(P, encoding='utf-8') as f:
    cfg = json.load(f)

cfg['hooks'] = {
    'enabled': True,
    'events': {
        'UserPromptSubmit': [
            {'hooks': [{
                'type': 'process',
                'command': 'C:/Program Files/Git/usr/bin/bash.exe',
                'args': ['D:/.opensource/zcode-context-insight/prototype/hook-heartbeat/heartbeat.sh'],
                'timeoutMs': 5000,
                'statusMessage': 'PROTOTYPE hook-heartbeat'
            }]}
        ]
    }
}

with open(P, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)

print(json.dumps(cfg['hooks'], indent=2))
