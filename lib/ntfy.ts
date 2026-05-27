const NTFY_TOPIC_URL = 'https://ntfy.sh/apicode';

type ProfitNotificationInput = {
  symbol: string;
  tradingMode: 'demo' | 'live';
  profitFiat: number;
  profitPercent: number;
};

function buildCurrencyLabel(tradingMode: 'demo' | 'live') {
  return tradingMode === 'live' ? 'USDC' : 'USDT';
}

export async function notifyPositiveClose(input: ProfitNotificationInput) {
  if (!(input.profitFiat > 0)) {
    return false;
  }

  const currency = buildCurrencyLabel(input.tradingMode);
  const title = `BITGET SIGNAL ${input.symbol}`;
  const body = [
    `Beneficio: +${input.profitFiat.toFixed(2)} ${currency}`,
    `Rentabilidad: +${input.profitPercent.toFixed(2)}%`,
  ].join('\n');

  const response = await fetch(NTFY_TOPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': title,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`ntfy responded with status ${response.status}`);
  }

  return true;
}
