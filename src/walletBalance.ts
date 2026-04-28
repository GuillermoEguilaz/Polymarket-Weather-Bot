import axios from "axios";
import { ClobClient, AssetType } from "@polymarket/clob-client-v2";
import type { BotConfig } from "./config";
import { getApiCreds, getFunderAddress, getSignerWallet } from "./clob";

const POLYGON_RPC = "https://polygon-rpc.com";
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
/** Polymarket USD (pUSD) proxy — CLOB V2 collateral on Polygon (see https://docs.polymarket.com/resources/contracts) */
const PUSD_POLYGON = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
/** pUSD uses 6 decimals (same unit scale as legacy USDC on CLOB). */
const COLLATERAL_DECIMALS = 6;
const BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * Get Polymarket USD (pUSD) collateral balance via CLOB API. Correct for EOA (0), Polymarket proxy (1), and Gnosis Safe (2).
 * Uses config.signature_type / proxy address so the right funder is used.
 * Returns balance in USD notional, or 0 on error.
 */
export async function getWalletBalanceUsdViaClob(cfg: BotConfig): Promise<number> {
  const pk = (cfg.polymarket_private_key || "").trim();
  if (!pk) return 0;

  try {
    const { wallet, apiCreds } = await getApiCreds(cfg);
    const signatureType = cfg.signature_type;
    const funderAddress = getFunderAddress(cfg, wallet);

    const client = new ClobClient({
      host: CLOB_HOST,
      chain: CHAIN_ID,
      signer: wallet,
      creds: apiCreds,
      signatureType,
      funderAddress: funderAddress || undefined,
      useServerTime: true,
    });

    const res = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL
    });
    const raw = parseFloat(res?.balance ?? "0");
    const balance = raw / 10 ** COLLATERAL_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    const wallet = getSignerWallet(cfg);
    const funderAddress = getFunderAddress(cfg, wallet);
    if (!funderAddress) return 0;
    return getWalletBalanceUsd(funderAddress);
  }
}

/**
 * Get pUSD balance for an address on Polygon via direct eth_call to the collateral token (EOA / raw wallet only).
 * Use getWalletBalanceUsdViaClob when using proxy/safe so CLOB returns the correct balance.
 */
export async function getWalletBalanceUsd(
  walletAddress: string
): Promise<number> {
  const addr = (walletAddress || "").trim();
  if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
    return 0;
  }

  const paddedAddr = addr.slice(2).toLowerCase().padStart(64, "0");
  const data = BALANCE_OF_SELECTOR + paddedAddr;

  try {
    const r = await axios.post(
      POLYGON_RPC,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: PUSD_POLYGON,
            data
          },
          "latest"
        ]
      },
      { timeout: 10000 }
    );

    const hex = r.data?.result as string | undefined;
    if (!hex || typeof hex !== "string") return 0;

    const raw = BigInt(hex);
    const balance = Number(raw) / 10 ** COLLATERAL_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    return 0;
  }
}
