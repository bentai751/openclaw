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

The ChatGPT Trading System plugin is a **simulated / paper-only** ledger + skill copied from denghao.0304's Instagram carousel (ChatGPT 交易系統 1.0): $10,000 starting cash, 30-day experiment, mandatory stop-loss, max 1% risk per trade, minimum 1:2 R:R. It does not place real orders and is not investment advice.
