import { Wallet } from "@ethersproject/wallet";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import type { BotConfig } from "./config";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137 as const;

/**
 * Authenticated CLOB client (proxy/safe funder from config when applicable).
 */
export function getSignerWallet(cfg: BotConfig): Wallet {
  const pk = cfg.polymarket_private_key.trim();
  return new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);
}

export function getFunderAddress(cfg: BotConfig, wallet?: Wallet): string | undefined {
  const signatureType = cfg.signature_type;
  const funder =
    signatureType === 1 || signatureType === 2
      ? cfg.polymarket_proxy_wallet_address.trim()
      : wallet?.address;
  return funder || undefined;
}

function hasValidApiCreds(value: unknown): value is {
  key: string;
  secret: string;
  passphrase: string;
} {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Record<string, unknown>;
  return (
    typeof maybe.key === "string" &&
    maybe.key.length > 0 &&
    typeof maybe.secret === "string" &&
    maybe.secret.length > 0 &&
    typeof maybe.passphrase === "string" &&
    maybe.passphrase.length > 0
  );
}

export async function getApiCreds(cfg: BotConfig): Promise<{
  client: ClobClient;
  wallet: Wallet;
  apiCreds: { key: string; secret: string; passphrase: string };
}> {
  const wallet = getSignerWallet(cfg);
  const funder = getFunderAddress(cfg, wallet);
  const signatureType = cfg.signature_type;
  const temp = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer: wallet,
    signatureType,
    funderAddress: funder,
    useServerTime: true,
  });

  let lastError: unknown;
  try {
    const apiCreds = await temp.deriveApiKey();
    if (hasValidApiCreds(apiCreds)) {
      return { client: temp, wallet, apiCreds };
    }
    lastError = new Error("deriveApiKey() returned invalid credentials");
  } catch (deriveError) {
    lastError = deriveError;
  }

  try {
    const apiCreds = await temp.createApiKey();
    if (hasValidApiCreds(apiCreds)) {
      return { client: temp, wallet, apiCreds };
    }
    throw new Error("createApiKey() returned invalid credentials");
  } catch (createError) {
    const details =
      createError instanceof Error
        ? createError.message
        : String(createError ?? lastError ?? "unknown error");
    throw new Error(
      `Failed to create or derive CLOB API credentials. Check private key, signature type, and proxy/funder address. Last error: ${details}`
    );
  }
}

export async function getClobClient(cfg: BotConfig): Promise<ClobClient> {
  const { wallet, apiCreds } = await getApiCreds(cfg);
  const signatureType = cfg.signature_type;
  const funder = getFunderAddress(cfg, wallet);
  return new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer: wallet,
    creds: apiCreds,
    signatureType,
    funderAddress: funder || undefined,
    useServerTime: true,
  });
}

export async function buyYesLimit(
  client: ClobClient,
  tokenId: string,
  price: number,
  sizeShares: number
): Promise<unknown> {
  return client.createAndPostOrder(
    {
      tokenID: tokenId,
      price,
      side: Side.BUY,
      size: sizeShares
    },
    undefined,
    OrderType.GTC
  );
}

export async function sellYesLimit(
  client: ClobClient,
  tokenId: string,
  price: number,
  sizeShares: number
): Promise<unknown> {
  return client.createAndPostOrder(
    {
      tokenID: tokenId,
      price,
      side: Side.SELL,
      size: sizeShares
    },
    undefined,
    OrderType.GTC
  );
}
