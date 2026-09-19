# OpenClaw Custom Plugins

This repository stores custom plugins for my OpenClaw deployment on Zeabur VPS.

## Included
- Google Sheets task tools for team task management
- ChatGPT Trading System v1.0 paper-trading workflow (research → signal → 1% risk → execute)

## Structure
- `plugins/google-sheets-task-tools/`
- `plugins/chatgpt-trading-system/`

## Notes
The Google Sheets plugin is installed into OpenClaw on the VPS and connects through a Google Apps Script Web App.

The ChatGPT Trading System plugin packs denghao.0304 Instagram workflows into OpenClaw skills + tools:

1. **chatgpt-trading** — $10k / 30-day paper account, research → plan → 1% risk → execute
2. **strategy-lab** — Claude Code × TradingView idea sweeps; rank vs buy-and-hold (高勝率 ≠ 高報酬)
3. **ai-trading-bot** — 24/7 pipeline: 市場 → 掃描 → 警示 → 分析 → 計畫 → 風險 → 紀錄

Paper / human-in-the-loop only. Does not place real orders. Not investment advice.
