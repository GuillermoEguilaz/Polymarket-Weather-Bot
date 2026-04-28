import { buyYesLimit, getClobClient, sellYesLimit } from "./clob";
import { BotConfig, getActiveLocations } from "./config";
import { badge, C, divider, info, ok, panel, progressBar, skip, stat, warn } from "./colors";
import { DailyForecast, LOCATIONS, getForecast } from "./nws";
import { hoursUntilResolution, parseTempRange } from "./parsing";
import {
  PolymarketEvent,
  PolymarketMarket,
  getPolymarketEvent,
  getMarketYesPrice,
  getYesTokenId
} from "./polymarket";
import { Position, Trade, loadSim, saveSim } from "./simState";
import { MONTHS } from "./time";
import type { ClobClient } from "@polymarket/clob-client-v2";

const POSITION_PCT = 0.05;
const MIN_PAPER_ORDER_USD = 0.5;
const MIN_EXECUTE_ORDER_USD = 1.0;

export type TradeMode = "dry-run" | "paper" | "execute";

export interface RunOptions {
  mode: TradeMode;
  config: BotConfig;
  /** Polymarket CLOB collateral balance (pUSD / Polymarket USD) — used for sizing in execute mode */
  walletUsd?: number;
}

function modeTone(mode: TradeMode): "green" | "yellow" | "cyan" {
  if (mode === "execute") return "green";
  if (mode === "paper") return "yellow";
  return "cyan";
}

function modeText(mode: TradeMode): string {
  if (mode === "execute") return "LIVE EXECUTION";
  if (mode === "paper") return "PAPER TRADING";
  return "SIGNAL ONLY";
}

function priceTone(
  price: number,
  entry: number,
  exit: number
): "green" | "yellow" | "red" {
  if (price < entry) return "green";
  if (price >= exit) return "red";
  return "yellow";
}

function shortQuestion(question: string, max = 62): string {
  return question.length > max ? `${question.slice(0, max - 1)}…` : question;
}

export async function showPositions(): Promise<void> {
  const sim = await loadSim();
  const positions = sim.positions;
  console.log(
    "\n" +
      panel(
        "Open Positions",
        [
          stat("Virtual balance", `$${sim.balance.toFixed(2)}`, "cyan"),
          stat("Open positions", `${Object.keys(positions).length}`, "blue"),
          stat("Trades", `${sim.total_trades}`, "magenta"),
          stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
        ],
        "blue"
      )
  );
  const mids = Object.keys(positions);
  if (!mids.length) {
    console.log(panel("Portfolio Status", [C.GRAY("No open positions right now.")], "gray"));
    return;
  }

  let totalPnl = 0;
  for (const mid of mids) {
    const pos = positions[mid];
    const currentPrice =
      (await getMarketYesPrice(mid)) ?? pos.entry_price ?? 0;
    const pnl = (currentPrice - pos.entry_price) * pos.shares;
    totalPnl += pnl;
    const pnlStr =
      pnl >= 0
        ? C.GREEN(`+$${pnl.toFixed(2)}`)
        : C.RED(`-$${Math.abs(pnl).toFixed(2)}`);
    const tone = pnl >= 0 ? "green" : "red";
    console.log(
      "\n" +
        panel(
          shortQuestion(pos.question, 68),
          [
            stat("Entry", `$${pos.entry_price.toFixed(3)}`, "cyan"),
            stat("Now", `$${currentPrice.toFixed(3)}`, tone),
            stat("Shares", pos.shares.toFixed(1), "blue"),
            stat("Cost", `$${pos.cost.toFixed(2)}`, "yellow"),
            stat("PnL", pnlStr, tone),
            `${C.DIM("Market odds")}   ${progressBar(currentPrice, 1, 26, tone)}`
          ],
          tone
        )
    );
  }

  const pnlColor = totalPnl >= 0 ? C.GREEN : C.RED;
  console.log(
    "\n" +
      panel(
        "Portfolio Summary",
        [
          stat("Balance", `$${sim.balance.toFixed(2)}`, "cyan"),
          stat(
            "Open PnL",
            pnlColor(`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`),
            totalPnl >= 0 ? "green" : "red"
          ),
          stat("Total trades", `${sim.total_trades}`, "blue"),
          stat("W/L", `${sim.wins}/${sim.losses}`, "yellow")
        ],
        totalPnl >= 0 ? "green" : "red"
      )
  );
}

export async function run(options: RunOptions): Promise<void> {
  const { mode, config } = options;

  const sim = await loadSim();
  const walletUsd = options.walletUsd;

  let balance: number =
    mode === "execute" && walletUsd != null && Number.isFinite(walletUsd)
      ? walletUsd
      : sim.balance;

  const positions = sim.positions;
  let tradesExecuted = 0;
  let exitsFound = 0;

  let clob: ClobClient | undefined;
  if (mode === "execute") {
    try {
      clob = await getClobClient(config);
    } catch (e) {
      warn(`Failed to init CLOB client: ${String(e)}`);
      return;
    }
  }

  const starting = sim.starting_balance;
  const totalReturn = ((balance - starting) / starting) * 100;
  const returnStr =
    totalReturn >= 0
      ? C.GREEN(`+${totalReturn.toFixed(1)}%`)
      : C.RED(`${totalReturn.toFixed(1)}%`);

  console.log(
    "\n" +
      panel(
        "Weather Trading Bot",
        [
          `${badge(modeText(mode), modeTone(mode))} ${C.DIM("Automated weather-market scanner")}`,
          "",
          stat(mode === "execute" ? "Wallet" : "Virtual balance", `$${balance.toFixed(2)}`, "cyan"),
          ...(mode !== "execute"
            ? [stat("Return vs start", `${returnStr}  ${C.DIM(`from $${starting.toFixed(2)}`)}`, totalReturn >= 0 ? "green" : "red")]
            : []),
          stat("Position size", `${(POSITION_PCT * 100).toFixed(0)}% of balance`, "blue"),
          stat("Entry threshold", `< $${config.entry_threshold.toFixed(2)}`, "green"),
          stat("Exit threshold", `>= $${config.exit_threshold.toFixed(2)}`, "red"),
          stat("Trade record", `${sim.wins} wins / ${sim.losses} losses`, "yellow")
        ],
        modeTone(mode)
      )
  );

  const persist = mode === "paper" || mode === "execute";

  // --- CHECK EXITS ---
  console.log(`\n${divider("EXIT SCAN", "magenta")}`);
  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);
    if (currentPrice == null) continue;

    if (currentPrice >= config.exit_threshold) {
      exitsFound += 1;
      const pnl = (currentPrice - pos.entry_price) * pos.shares;
      console.log(
        panel(
          `Exit Candidate • ${shortQuestion(pos.question, 56)}`,
          [
            stat("Current price", `$${currentPrice.toFixed(3)}`, "red"),
            stat("Exit threshold", `$${config.exit_threshold.toFixed(2)}`, "yellow"),
            stat("Shares", pos.shares.toFixed(1), "blue"),
            stat(
              "Estimated PnL",
              `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
              pnl >= 0 ? "green" : "red"
            ),
            `${C.DIM("Odds gauge")}     ${progressBar(currentPrice, 1, 26, "red")}`
          ],
          "magenta"
        )
      );

      if (mode === "execute") {
        if (!pos.token_id || !clob) {
          warn("Missing CLOB token_id for this position — cannot sell on-chain");
          continue;
        }
        const sellPx = Math.max(currentPrice - 0.01, 0.01);
        try {
          await sellYesLimit(clob, pos.token_id, sellPx, pos.shares);
          ok("CLOB sell order submitted");
        } catch (e) {
          warn(`CLOB sell failed: ${String(e)}`);
          continue;
        }
        balance += pos.cost + pnl;
        const est = pnl;
        if (est > 0) sim.wins += 1;
        else sim.losses += 1;
        const trade: Trade = {
          type: "exit",
          question: pos.question,
          entry_price: pos.entry_price,
          exit_price: currentPrice,
          pnl: Number(est.toFixed(2)),
          cost: pos.cost,
          closed_at: new Date().toISOString()
        };
        sim.trades.push(trade);
        delete positions[mid];
        ok(`Closed — est. PnL: ${est >= 0 ? "+" : ""}${est.toFixed(2)}`);
      } else if (mode === "paper") {
        balance += pos.cost + pnl;
        if (pnl > 0) sim.wins += 1;
        else sim.losses += 1;
        const trade: Trade = {
          type: "exit",
          question: pos.question,
          entry_price: pos.entry_price,
          exit_price: currentPrice,
          pnl: Number(pnl.toFixed(2)),
          cost: pos.cost,
          closed_at: new Date().toISOString()
        };
        sim.trades.push(trade);
        delete positions[mid];
        ok(
          `Closed — PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
        );
      } else {
        skip("Dry-run — not selling");
      }
    }
  }

  if (exitsFound === 0) {
    skip("No exit opportunities");
  }

  // --- SCAN ENTRIES ---
  console.log(`\n${divider("ENTRY SCAN", "cyan")}`);

  const activeLocations = getActiveLocations(config);
  for (const citySlug of activeLocations) {
    if (!(citySlug in LOCATIONS)) {
      continue;
    }

    const locData = LOCATIONS[citySlug];
    const forecast: DailyForecast = await getForecast(citySlug);
    if (!forecast || Object.keys(forecast).length === 0) continue;

    for (let i = 0; i < 4; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      const dateStr = date.toISOString().slice(0, 10);
      const month = MONTHS[date.getMonth()];
      const day = date.getDate();
      const year = date.getFullYear();

      const forecastTemp = forecast[dateStr];
      if (forecastTemp == null) continue;

      const event: PolymarketEvent | null = await getPolymarketEvent(
        citySlug,
        month,
        day,
        year
      );
      if (!event) continue;

      const hoursLeft = hoursUntilResolution(event);
      console.log(
        "\n" +
          panel(
            `${locData.name} • ${dateStr}`,
            [
              stat("Forecast max", `${forecastTemp}°F`, "cyan"),
              stat("Resolves in", `${hoursLeft.toFixed(0)}h`, hoursLeft < config.min_hours_to_resolution ? "red" : "green"),
              stat("Market date", `${month} ${day}, ${year}`, "blue")
            ],
            "blue"
          )
      );

      if (hoursLeft < config.min_hours_to_resolution) {
        skip(`Resolves in ${hoursLeft.toFixed(0)}h — too soon`);
        continue;
      }

      let matched:
        | {
            market: PolymarketMarket;
            question: string;
            price: number;
            range: [number, number];
          }
        | null = null;

      for (const market of event.markets ?? []) {
        const question = market.question ?? "";
        const rng = parseTempRange(question);
        if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
          try {
            const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
            const prices = JSON.parse(pricesStr) as number[];
            const yesPrice = Number(prices[0]);
            if (!isFinite(yesPrice)) continue;
            matched = {
              market,
              question,
              price: yesPrice,
              range: rng
            };
          } catch {
            continue;
          }
          break;
        }
      }

      if (!matched) {
        skip(`No bucket found for ${forecastTemp}°F`);
        continue;
      }

      const price = matched.price;
      const marketId = matched.market.id;
      const question = matched.question;
      const tone = priceTone(price, config.entry_threshold, config.exit_threshold);
      console.log(
        panel(
          `Matched Bucket • ${shortQuestion(question, 52)}`,
          [
            stat("Forecast temp", `${forecastTemp}°F`, "cyan"),
            stat("YES price", `$${price.toFixed(3)}`, tone),
            stat("Entry trigger", `< $${config.entry_threshold.toFixed(2)}`, "green"),
            stat("Exit trigger", `>= $${config.exit_threshold.toFixed(2)}`, "red"),
            `${C.DIM("Market odds")}   ${progressBar(price, 1, 26, tone)}`
          ],
          tone
        )
      );

      if (price >= config.entry_threshold) {
        skip(
          `Price $${price.toFixed(
            3
          )} above threshold $${config.entry_threshold.toFixed(2)}`
        );
        continue;
      }

      const basePositionSize = Number((balance * POSITION_PCT).toFixed(2));
      const minOrderUsd =
        mode === "execute" ? MIN_EXECUTE_ORDER_USD : MIN_PAPER_ORDER_USD;
      const positionSize = Number(Math.max(basePositionSize, minOrderUsd).toFixed(2));

      if (balance < minOrderUsd) {
        skip(
          `Wallet balance $${balance.toFixed(
            2
          )} is below the live minimum order size of $${minOrderUsd.toFixed(2)}`
        );
        continue;
      }

      const shares = positionSize / price;
      console.log(
        panel(
          `Entry Signal • ${locData.name}`,
          [
            stat("Action", `${mode === "execute" ? "BUY YES" : "BUY SETUP"}`, "green"),
            stat("Price", `$${price.toFixed(3)}`, "green"),
            stat("Position size", `$${positionSize.toFixed(2)}`, "yellow"),
            ...(positionSize !== basePositionSize
              ? [stat("Base 5% size", `$${basePositionSize.toFixed(2)}`, "gray")]
              : []),
            stat("Estimated shares", shares.toFixed(1), "blue"),
            `${C.DIM("Sizing gauge")}  ${progressBar(positionSize, Math.max(balance, 1), 26, "green")}`
          ],
          "green"
        )
      );

      if (positions[marketId]) {
        skip("Already in this market");
        continue;
      }

      if (tradesExecuted >= config.max_trades_per_run) {
        skip(`Max trades (${config.max_trades_per_run}) reached`);
        continue;
      }

      if (positionSize < minOrderUsd) {
        skip(`Position size $${positionSize.toFixed(2)} too small`);
        continue;
      }

      if (mode === "execute") {
        const tokenId = getYesTokenId(matched.market);
        if (!tokenId || !clob) {
          warn("No clobTokenIds on market — cannot trade this market on CLOB");
          continue;
        }
        const limitPx = Math.min(price + 0.03, 0.99);
        try {
          await buyYesLimit(clob, tokenId, limitPx, shares);
          ok(`CLOB buy order submitted @ limit $${limitPx.toFixed(3)}`);
        } catch (e) {
          warn(`CLOB buy failed: ${String(e)}`);
          continue;
        }
        const pos: Position = {
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          date: dateStr,
          location: citySlug,
          forecast_temp: forecastTemp,
          opened_at: new Date().toISOString(),
          token_id: tokenId
        };
        positions[marketId] = pos;
        sim.total_trades += 1;
        const trade: Trade = {
          type: "entry",
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          opened_at: pos.opened_at
        };
        sim.trades.push(trade);
        tradesExecuted += 1;
        balance -= positionSize;
      } else if (mode === "paper") {
        balance -= positionSize;
        const pos: Position = {
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          date: dateStr,
          location: citySlug,
          forecast_temp: forecastTemp,
          opened_at: new Date().toISOString()
        };
        positions[marketId] = pos;
        sim.total_trades += 1;
        const trade: Trade = {
          type: "entry",
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          opened_at: pos.opened_at
        };
        sim.trades.push(trade);
        tradesExecuted += 1;
        ok(
          `Position opened — $${positionSize.toFixed(
            2
          )} deducted from balance`
        );
      } else {
        skip("Dry-run — not buying");
        tradesExecuted += 1;
      }
    }
  }

  if (persist) {
    sim.balance = Number(balance.toFixed(2));
    sim.positions = positions;
    sim.peak_balance = Math.max(sim.peak_balance ?? balance, balance);
    await saveSim(sim);
  }

  console.log(
    "\n" +
      panel(
        "Run Summary",
        [
          stat("Ending balance", `$${balance.toFixed(2)}`, "cyan"),
          stat("Trades this run", `${tradesExecuted}`, tradesExecuted > 0 ? "green" : "gray"),
          stat("Exits found", `${exitsFound}`, exitsFound > 0 ? "magenta" : "gray"),
          stat("Open positions", `${Object.keys(positions).length}`, "blue"),
          `${C.DIM("Bot mode")}       ${badge(modeText(mode), modeTone(mode))}`
        ],
        modeTone(mode)
      )
  );

  if (mode === "dry-run") {
    console.log(
      "\n" +
        panel(
          "Dry-Run Reminder",
          [
            C.YELLOW("No orders were submitted in this run."),
            "Use `--live` for paper trading or `--execute` for real CLOB orders."
          ],
          "yellow"
        )
    );
  }
}
