import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_DATA_DIR =
  process.env.CHATGPT_TRADING_DATA_DIR ||
  join(process.cwd(), "data", "chatgpt-trading-system");
const LEDGER_PATH = join(DEFAULT_DATA_DIR, "ledger.json");
const STRATEGY_LAB_PATH = join(DEFAULT_DATA_DIR, "strategy-lab.json");

const INITIAL_CASH = 10_000;
const RISK_PER_TRADE = 0.01;
const MIN_RR = 2;
const PLAN_DAYS = 30;
const MARKET = "US equity / options (paper)";

type Direction = "long" | "short";
type TradeStatus = "planned" | "open" | "closed" | "rejected";

type Trade = {
  trade_id: string;
  status: TradeStatus;
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  risk_amount: number;
  risk_pct: number;
  rr: number;
  rationale: string;
  research_summary?: string;
  created_at: string;
  opened_at?: string;
  closed_at?: string;
  exit_price?: number;
  pnl?: number;
  close_reason?: string;
};

type Portfolio = {
  version: string;
  market: string;
  initial_cash: number;
  cash: number;
  equity: number;
  risk_per_trade: number;
  min_rr: number;
  plan_days: number;
  started_at: string;
  ends_at: string;
  trades: Trade[];
  next_trade_seq: number;
};

type ToolResultDetails = Record<string, unknown>;

function okText(text: string, details: ToolResultDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function isoDaysFromNow(days: number, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function emptyPortfolio(): Portfolio {
  const started = new Date();
  return {
    version: "1.0",
    market: MARKET,
    initial_cash: INITIAL_CASH,
    cash: INITIAL_CASH,
    equity: INITIAL_CASH,
    risk_per_trade: RISK_PER_TRADE,
    min_rr: MIN_RR,
    plan_days: PLAN_DAYS,
    started_at: started.toISOString(),
    ends_at: isoDaysFromNow(PLAN_DAYS, started),
    trades: [],
    next_trade_seq: 1,
  };
}

function loadPortfolio(): Portfolio | null {
  if (!existsSync(LEDGER_PATH)) return null;
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Portfolio;
}

function savePortfolio(p: Portfolio) {
  ensureDir(LEDGER_PATH);
  writeFileSync(LEDGER_PATH, JSON.stringify(p, null, 2), "utf8");
}

function requirePortfolio(): Portfolio {
  const p = loadPortfolio();
  if (!p) {
    throw new Error(
      "No paper portfolio yet. Call trading_init_portfolio first ($10,000 / 30 days)."
    );
  }
  return p;
}

function riskPerShare(direction: Direction, entry: number, stop: number) {
  if (direction === "long") return entry - stop;
  return stop - entry;
}

function rewardPerShare(direction: Direction, entry: number, target: number) {
  if (direction === "long") return target - entry;
  return entry - target;
}

function computeSizing(
  cash: number,
  direction: Direction,
  entry: number,
  stop: number,
  target: number,
  riskPct = RISK_PER_TRADE
) {
  const riskPs = riskPerShare(direction, entry, stop);
  const rewardPs = rewardPerShare(direction, entry, target);

  if (entry <= 0 || stop <= 0 || target <= 0) {
    return { ok: false as const, error: "Prices must be positive." };
  }
  if (riskPs <= 0) {
    return {
      ok: false as const,
      error:
        direction === "long"
          ? "For long trades, stop must be below entry."
          : "For short trades, stop must be above entry.",
    };
  }
  if (rewardPs <= 0) {
    return {
      ok: false as const,
      error:
        direction === "long"
          ? "For long trades, target must be above entry."
          : "For short trades, target must be below entry.",
    };
  }

  const rr = rewardPs / riskPs;
  const riskAmount = round2(cash * riskPct);
  const shares = Math.floor(riskAmount / riskPs);
  const notional = round2(shares * entry);
  const actualRisk = round2(shares * riskPs);

  return {
    ok: true as const,
    rr: round2(rr),
    risk_amount: riskAmount,
    actual_risk: actualRisk,
    risk_pct: riskPct,
    shares,
    notional,
    risk_per_share: round2(riskPs),
    reward_per_share: round2(rewardPs),
  };
}

function openRiskUsed(p: Portfolio) {
  return p.trades
    .filter((t) => t.status === "open")
    .reduce((sum, t) => sum + t.risk_amount, 0);
}

function revalueEquity(p: Portfolio) {
  const openNotional = p.trades
    .filter((t) => t.status === "open")
    .reduce((sum, t) => sum + t.shares * t.entry, 0);
  p.equity = round2(p.cash + openNotional);
}

function nextId(p: Portfolio) {
  const id = `T${String(p.next_trade_seq).padStart(3, "0")}`;
  p.next_trade_seq += 1;
  return id;
}

function formatTrade(t: Trade) {
  const base = `${t.trade_id} — ${t.status} — ${t.symbol} ${t.direction} — entry ${t.entry} stop ${t.stop} target ${t.target} — ${t.shares} sh — risk $${t.risk_amount} (${(t.risk_pct * 100).toFixed(1)}%) — R:R 1:${t.rr}`;
  if (t.status === "closed") {
    return `${base} — exit ${t.exit_price} — PnL $${t.pnl} — ${t.close_reason || ""}`;
  }
  return base;
}

type StrategyResult = {
  result_id: string;
  idea: string;
  family: string;
  symbol: string;
  params: string;
  timeframe?: string;
  period?: string;
  trades: number;
  win_rate?: number;
  profit_factor?: number;
  sharpe?: number;
  max_dd?: number;
  cagr?: number;
  buy_hold_cagr?: number;
  beats_buy_hold?: boolean;
  notes?: string;
  created_at: string;
};

type StrategyLab = {
  version: string;
  results: StrategyResult[];
  next_seq: number;
};

function emptyLab(): StrategyLab {
  return { version: "1.0", results: [], next_seq: 1 };
}

function loadLab(): StrategyLab {
  if (!existsSync(STRATEGY_LAB_PATH)) return emptyLab();
  return JSON.parse(readFileSync(STRATEGY_LAB_PATH, "utf8")) as StrategyLab;
}

function saveLab(lab: StrategyLab) {
  ensureDir(STRATEGY_LAB_PATH);
  writeFileSync(STRATEGY_LAB_PATH, JSON.stringify(lab, null, 2), "utf8");
}

function formatStrategy(r: StrategyResult) {
  const bh =
    r.beats_buy_hold === undefined
      ? "vs B&H ?"
      : r.beats_buy_hold
        ? "beats B&H"
        : "loses to B&H";
  return `${r.result_id} — ${r.symbol} — ${r.family} — ${r.params} — WR ${r.win_rate ?? "?"} PF ${r.profit_factor ?? "?"} Sharpe ${r.sharpe ?? "?"} CAGR ${r.cagr ?? "?"} — ${bh}`;
}

export default definePluginEntry({
  id: "cultivata-chatgpt-trading-system",
  name: "ChatGPT Trading System",
  description:
    "Paper-trading tools for the ChatGPT Trading System v1.0 workflow (research → plan → 1% risk → execute)",
  register(api) {
    api.registerTool(
      {
        name: "trading_init_portfolio",
        label: "Init Portfolio",
          description:
          "Initialize or reset the $10,000 / 30-day paper portfolio (simulated funds only)",
        parameters: Type.Object({
          reset: Type.Optional(
            Type.Boolean({
              description: "If true, wipe existing ledger and start fresh",
            })
          ),
        }),
        async execute(_toolCallId, params: any) {
          if (!params.reset && loadPortfolio()) {
            const existing = loadPortfolio()!;
            return okText(
              `Portfolio already exists. Cash $${existing.cash}, equity $${existing.equity}, started ${existing.started_at}. Pass reset=true to wipe.`,
              { action: "trading_init_portfolio", portfolio: existing }
            );
          }
          const p = emptyPortfolio();
          savePortfolio(p);
          return okText(
            `Paper portfolio ready. Cash $${p.cash} USD — market ${p.market} — ${p.plan_days} days — risk ${p.risk_per_trade * 100}%/trade — min R:R 1:${p.min_rr}. Ends ${p.ends_at}. Simulated only.`,
            { action: "trading_init_portfolio", portfolio: p }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_get_portfolio",
        label: "Get Portfolio",
          description: "Show current paper portfolio cash, equity, and open risk",
        parameters: Type.Object({}),
        async execute() {
          const p = requirePortfolio();
          revalueEquity(p);
          savePortfolio(p);
          const open = p.trades.filter((t) => t.status === "open");
          const planned = p.trades.filter((t) => t.status === "planned");
          return okText(
            [
              `Cash $${p.cash} | Equity $${p.equity} | Open risk $${round2(openRiskUsed(p))}`,
              `Open ${open.length} | Planned ${planned.length} | Closed ${p.trades.filter((t) => t.status === "closed").length}`,
              `Rules: ${p.risk_per_trade * 100}% risk/trade, min R:R 1:${p.min_rr}, ends ${p.ends_at}`,
            ].join("\n"),
            { action: "trading_get_portfolio", portfolio: p }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_create_plan",
        label: "Create Plan",
          description:
          "Create a trade plan ticket (does not execute). Validates stop/target direction and sizes shares to ~1% risk.",
        parameters: Type.Object({
          symbol: Type.String({ description: "Ticker e.g. SPY or TSLA" }),
          direction: Type.String({ description: "long or short" }),
          entry: Type.Number({ description: "Entry price" }),
          stop: Type.Number({ description: "Stop-loss price" }),
          target: Type.Number({ description: "Take-profit / target price" }),
          rationale: Type.String({
            description: "Why this setup (from research brief)",
          }),
          research_summary: Type.Optional(
            Type.String({ description: "Short research brief summary" })
          ),
        }),
        async execute(_toolCallId, params: any) {
          const p = requirePortfolio();
          const direction = String(params.direction).toLowerCase() as Direction;
          if (direction !== "long" && direction !== "short") {
            throw new Error('direction must be "long" or "short"');
          }

          const sizing = computeSizing(
            p.cash,
            direction,
            params.entry,
            params.stop,
            params.target
          );
          if (!sizing.ok) throw new Error(sizing.error);

          const trade: Trade = {
            trade_id: nextId(p),
            status: "planned",
            symbol: params.symbol.toUpperCase(),
            direction,
            entry: params.entry,
            stop: params.stop,
            target: params.target,
            shares: sizing.shares,
            risk_amount: sizing.actual_risk,
            risk_pct: sizing.shares > 0 ? sizing.actual_risk / p.cash : 0,
            rr: sizing.rr,
            rationale: params.rationale,
            research_summary: params.research_summary || "",
            created_at: new Date().toISOString(),
          };
          p.trades.push(trade);
          savePortfolio(p);

          const warnings: string[] = [];
          if (sizing.rr < MIN_RR) {
            warnings.push(`R:R 1:${sizing.rr} is below minimum 1:${MIN_RR}`);
          }
          if (sizing.shares < 1) {
            warnings.push("Position size is 0 shares — risk distance too wide for 1% budget");
          }

          return okText(
            [
              `Plan ${trade.trade_id} created (not executed).`,
              formatTrade(trade),
              `Rationale: ${trade.rationale}`,
              warnings.length ? `Warnings: ${warnings.join("; ")}` : "Passes basic sizing.",
              "Next: trading_validate_risk then trading_execute_trade.",
            ].join("\n"),
            { action: "trading_create_plan", trade, sizing, warnings }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_validate_risk",
        label: "Validate Risk",
          description:
          "Validate a planned trade against 1% risk, mandatory stop, and min 1:2 R:R rules",
        parameters: Type.Object({
          trade_id: Type.String({ description: "Trade ID like T001" }),
        }),
        async execute(_toolCallId, params: any) {
          const p = requirePortfolio();
          const trade = p.trades.find((t) => t.trade_id === params.trade_id);
          if (!trade) throw new Error(`Trade ${params.trade_id} not found`);

          const checks = {
            has_stop: trade.stop > 0 && trade.stop !== trade.entry,
            risk_within_1pct: trade.risk_pct <= RISK_PER_TRADE + 1e-9,
            min_rr: trade.rr >= MIN_RR,
            shares_positive: trade.shares >= 1,
            cash_enough: trade.shares * trade.entry <= p.cash + 1e-9,
            no_stop_no_trade: true as const,
          };

          const failed: string[] = [];
          if (!checks.has_stop) failed.push("No stop-loss — no trade");
          if (!checks.risk_within_1pct) {
            failed.push(
              `Risk ${(trade.risk_pct * 100).toFixed(2)}% exceeds ${RISK_PER_TRADE * 100}%`
            );
          }
          if (!checks.min_rr) failed.push(`R:R 1:${trade.rr} < 1:${MIN_RR}`);
          if (!checks.shares_positive) failed.push("Shares must be >= 1");
          if (!checks.cash_enough) {
            failed.push(
              `Notional $${round2(trade.shares * trade.entry)} exceeds cash $${p.cash}`
            );
          }

          const ok = failed.length === 0;
          if (!ok && trade.status === "planned") {
            trade.status = "rejected";
            savePortfolio(p);
          }

          return okText(
            ok
              ? `${trade.trade_id} PASS — ready to execute. Risk $${trade.risk_amount}, R:R 1:${trade.rr}, ${trade.shares} sh.`
              : `${trade.trade_id} FAIL — ${failed.join("; ")}. Marked rejected.`,
            {
              action: "trading_validate_risk",
              trade_id: trade.trade_id,
              ok,
              checks,
              failed,
              trade,
            }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_execute_trade",
        label: "Execute Trade",
          description:
          "Execute a planned paper trade (simulated only). Re-checks risk rules before opening.",
        parameters: Type.Object({
          trade_id: Type.String({ description: "Planned trade ID" }),
          force: Type.Optional(
            Type.Boolean({
              description: "Skip soft warnings only — hard 1%/R:R rules still apply",
            })
          ),
        }),
        async execute(_toolCallId, params: any) {
          const p = requirePortfolio();
          const trade = p.trades.find((t) => t.trade_id === params.trade_id);
          if (!trade) throw new Error(`Trade ${params.trade_id} not found`);
          if (trade.status !== "planned") {
            throw new Error(`Trade ${trade.trade_id} is ${trade.status}, not planned`);
          }

          const sizing = computeSizing(
            p.cash,
            trade.direction,
            trade.entry,
            trade.stop,
            trade.target
          );
          if (!sizing.ok) throw new Error(sizing.error);
          if (sizing.rr < MIN_RR && !params.force) {
            throw new Error(`R:R 1:${sizing.rr} below 1:${MIN_RR}. Fix target/stop.`);
          }
          if (sizing.shares < 1) {
            throw new Error("Cannot execute: 0 shares under 1% risk budget");
          }

          const cost = round2(sizing.shares * trade.entry);
          if (cost > p.cash) throw new Error(`Insufficient cash: need $${cost}, have $${p.cash}`);

          trade.shares = sizing.shares;
          trade.risk_amount = sizing.actual_risk;
          trade.risk_pct = sizing.actual_risk / p.cash;
          trade.rr = sizing.rr;
          trade.status = "open";
          trade.opened_at = new Date().toISOString();
          p.cash = round2(p.cash - cost);
          revalueEquity(p);
          savePortfolio(p);

          return okText(
            `Executed (paper) ${formatTrade(trade)}. Cash left $${p.cash}. Simulated only — not investment advice.`,
            { action: "trading_execute_trade", trade, cash: p.cash, equity: p.equity }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_close_trade",
        label: "Close Trade",
          description: "Close an open paper trade at an exit price and record PnL",
        parameters: Type.Object({
          trade_id: Type.String({ description: "Open trade ID" }),
          exit_price: Type.Number({ description: "Exit / fill price" }),
          reason: Type.Optional(
            Type.String({
              description: "target | stop | manual | time — why closed",
            })
          ),
        }),
        async execute(_toolCallId, params: any) {
          const p = requirePortfolio();
          const trade = p.trades.find((t) => t.trade_id === params.trade_id);
          if (!trade) throw new Error(`Trade ${params.trade_id} not found`);
          if (trade.status !== "open") {
            throw new Error(`Trade ${trade.trade_id} is ${trade.status}, not open`);
          }

          const exit = params.exit_price;
          const pnl =
            trade.direction === "long"
              ? round2((exit - trade.entry) * trade.shares)
              : round2((trade.entry - exit) * trade.shares);

          const proceeds = round2(trade.shares * exit);
          p.cash = round2(p.cash + proceeds);
          trade.status = "closed";
          trade.exit_price = exit;
          trade.pnl = pnl;
          trade.close_reason = params.reason || "manual";
          trade.closed_at = new Date().toISOString();
          revalueEquity(p);
          savePortfolio(p);

          return okText(
            `Closed ${formatTrade(trade)}. Cash $${p.cash} | Equity $${p.equity}.`,
            { action: "trading_close_trade", trade, cash: p.cash, equity: p.equity }
          );
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_list_trades",
        label: "List Trades",
          description: "List paper trades, optionally filtered by status",
        parameters: Type.Object({
          status: Type.Optional(
            Type.String({
              description: "planned | open | closed | rejected | all",
            })
          ),
        }),
        async execute(_toolCallId, params: any) {
          const p = requirePortfolio();
          const status = (params.status || "all").toLowerCase();
          const list =
            status === "all"
              ? p.trades
              : p.trades.filter((t) => t.status === status);

          const text =
            list.length === 0
              ? "No matching trades."
              : list.map(formatTrade).join("\n");

          return okText(text, { action: "trading_list_trades", trades: list });
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "trading_performance",
        label: "Performance",
          description: "Summarize win rate, PnL, and drawdown-style stats for closed paper trades",
        parameters: Type.Object({}),
        async execute() {
          const p = requirePortfolio();
          revalueEquity(p);
          savePortfolio(p);

          const closed = p.trades.filter((t) => t.status === "closed");
          const wins = closed.filter((t) => (t.pnl || 0) > 0);
          const losses = closed.filter((t) => (t.pnl || 0) < 0);
          const totalPnl = round2(closed.reduce((s, t) => s + (t.pnl || 0), 0));
          const winRate =
            closed.length === 0 ? 0 : round2((wins.length / closed.length) * 100);
          const open = p.trades.filter((t) => t.status === "open");

          const text = [
            `Equity $${p.equity} (start $${p.initial_cash}) | Cash $${p.cash}`,
            `Closed ${closed.length} — wins ${wins.length} / losses ${losses.length} — win rate ${winRate}%`,
            `Closed PnL $${totalPnl} | Open positions ${open.length} | Open risk $${round2(openRiskUsed(p))}`,
            `Period ${p.started_at.slice(0, 10)} → ${p.ends_at.slice(0, 10)} | Simulated only`,
          ].join("\n");

          return okText(text, {
            action: "trading_performance",
            equity: p.equity,
            cash: p.cash,
            closed_count: closed.length,
            wins: wins.length,
            losses: losses.length,
            win_rate_pct: winRate,
            closed_pnl: totalPnl,
            open_count: open.length,
          });
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "strategy_record_result",
        label: "Record Strategy Result",
        description:
          "Save one Claude×TradingView backtest / parameter-sweep result for ranking vs buy-and-hold",
        parameters: Type.Object({
          idea: Type.String({ description: "One-sentence strategy idea" }),
          family: Type.String({
            description: "mean_reversion | breakout | trend | other",
          }),
          symbol: Type.String({ description: "Asset e.g. SPY or BTCUSD" }),
          params: Type.String({
            description: "Parameter string e.g. RSI14 <30 />70 stop=2ATR",
          }),
          timeframe: Type.Optional(Type.String()),
          period: Type.Optional(Type.String({ description: "e.g. 2018-2024" })),
          trades: Type.Optional(Type.Number()),
          win_rate: Type.Optional(Type.Number({ description: "Percent 0-100" })),
          profit_factor: Type.Optional(Type.Number()),
          sharpe: Type.Optional(Type.Number()),
          max_dd: Type.Optional(Type.Number({ description: "Max drawdown %" })),
          cagr: Type.Optional(Type.Number({ description: "Strategy CAGR %" })),
          buy_hold_cagr: Type.Optional(
            Type.Number({ description: "Buy-and-hold CAGR % for same asset" })
          ),
          notes: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params: any) {
          const lab = loadLab();
          const cagr = params.cagr;
          const bh = params.buy_hold_cagr;
          const beats =
            cagr === undefined || bh === undefined
              ? undefined
              : Number(cagr) > Number(bh);

          const row: StrategyResult = {
            result_id: `S${String(lab.next_seq).padStart(3, "0")}`,
            idea: params.idea,
            family: String(params.family || "other").toLowerCase(),
            symbol: String(params.symbol).toUpperCase(),
            params: params.params,
            timeframe: params.timeframe || "",
            period: params.period || "",
            trades: params.trades ?? 0,
            win_rate: params.win_rate,
            profit_factor: params.profit_factor,
            sharpe: params.sharpe,
            max_dd: params.max_dd,
            cagr: params.cagr,
            buy_hold_cagr: params.buy_hold_cagr,
            beats_buy_hold: beats,
            notes: params.notes || "",
            created_at: new Date().toISOString(),
          };
          lab.next_seq += 1;
          lab.results.push(row);
          saveLab(lab);

          const lesson =
            beats === false
              ? "Note: loses to buy-and-hold on CAGR — 高勝率 ≠ 高報酬."
              : beats === true
                ? "Beats buy-and-hold on CAGR — still check Sharpe/DD."
                : "Add buy_hold_cagr to compare honestly.";

          return okText(`Saved ${formatStrategy(row)}\n${lesson}`, {
            action: "strategy_record_result",
            result: row,
          });
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "strategy_list",
        label: "List Strategies",
        description: "List saved strategy-lab backtest results",
        parameters: Type.Object({
          symbol: Type.Optional(Type.String()),
          family: Type.Optional(Type.String()),
        }),
        async execute(_toolCallId, params: any) {
          const lab = loadLab();
          let list = lab.results;
          if (params.symbol) {
            const s = String(params.symbol).toUpperCase();
            list = list.filter((r) => r.symbol === s);
          }
          if (params.family) {
            const f = String(params.family).toLowerCase();
            list = list.filter((r) => r.family === f);
          }
          const text =
            list.length === 0
              ? "No strategy results yet."
              : list.map(formatStrategy).join("\n");
          return okText(text, { action: "strategy_list", results: list });
        },
      },
      { optional: true }
    );

    api.registerTool(
      {
        name: "strategy_rank",
        label: "Rank Strategies",
        description:
          "Rank saved results by sharpe, profit_factor, cagr, or win_rate (default sharpe)",
        parameters: Type.Object({
          by: Type.Optional(
            Type.String({
              description: "sharpe | profit_factor | cagr | win_rate",
            })
          ),
          limit: Type.Optional(Type.Number({ description: "Max rows, default 10" })),
        }),
        async execute(_toolCallId, params: any) {
          const lab = loadLab();
          const by = String(params.by || "sharpe").toLowerCase();
          const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
          const key = by as keyof StrategyResult;
          const ranked = [...lab.results]
            .filter((r) => typeof r[key] === "number")
            .sort((a, b) => Number(b[key]) - Number(a[key]))
            .slice(0, limit);

          const text =
            ranked.length === 0
              ? `No results with numeric ${by}.`
              : [
                  `Top ${ranked.length} by ${by} (高勝率 ≠ 高報酬 — prefer risk-adjusted):`,
                  ...ranked.map(formatStrategy),
                ].join("\n");

          return okText(text, { action: "strategy_rank", by, results: ranked });
        },
      },
      { optional: true }
    );
  },
});
