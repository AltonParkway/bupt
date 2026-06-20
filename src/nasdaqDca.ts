export interface MarketPoint {
    date: string;
    close: number;
    earningsYield?: number;
    riskFreeYield?: number;
    revenueGrowth?: number;
    marginTrend?: number;
    sectorMomentum?: number;
    industryScore?: number;
}

export interface DcaConfig {
    baseContribution: number;
    minMultiplier: number;
    maxMultiplier: number;
    requiredSpread: number;
    spreadBand: number;
    revenueGrowthTarget: number;
    marginTrendBand: number;
    sectorMomentumBand: number;
    movingAverageBand: number;
    highRateThreshold: number;
    rateBand: number;
    volatilityThreshold: number;
    volatilityBand: number;
    cashYieldFallback: number;
    weights: {
        value: number;
        drawdown: number;
        industry: number;
        rate: number;
        volatility: number;
    };
}

export interface DcaDecision {
    date: string;
    baseContribution: number;
    targetContribution: number;
    multiplier: number;
    scores: {
        value: number;
        drawdown: number;
        industry: number;
        rate: number;
        volatility: number;
    };
    rationale: string[];
}

export interface BacktestRow {
    date: string;
    close: number;
    fixedContribution: number;
    dynamicContribution: number;
    targetDynamicContribution: number;
    fixedValue: number;
    dynamicValue: number;
    dynamicCash: number;
    dynamicMultiplier: number;
}

export interface BacktestSummary {
    months: number;
    totalContributed: number;
    fixedInvested: number;
    dynamicInvested: number;
    dynamicEndingCash: number;
    fixedFinalValue: number;
    dynamicFinalValue: number;
    fixedTotalReturn: number;
    dynamicTotalReturn: number;
    fixedXirr?: number;
    dynamicXirr?: number;
    fixedMaxDrawdown: number;
    dynamicMaxDrawdown: number;
    averageDynamicMultiplier: number;
}

export interface BacktestResult {
    config: DcaConfig;
    latestDecision: DcaDecision;
    summary: BacktestSummary;
    rows: BacktestRow[];
}

interface TrailingContext {
    movingAverageDiscount?: number;
    trailingVolatility?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;

export const defaultDcaConfig: DcaConfig = {
    baseContribution: 1000,
    minMultiplier: 0.25,
    maxMultiplier: 2.5,
    requiredSpread: 0.02,
    spreadBand: 0.05,
    revenueGrowthTarget: 0.10,
    marginTrendBand: 0.05,
    sectorMomentumBand: 0.20,
    movingAverageBand: 0.30,
    highRateThreshold: 0.045,
    rateBand: 0.025,
    volatilityThreshold: 0.25,
    volatilityBand: 0.20,
    cashYieldFallback: 0,
    weights: {
        value: 0.55,
        drawdown: 0.35,
        industry: 0.25,
        rate: 0.20,
        volatility: 0.15,
    },
};

export function mergeDcaConfig(
    overrides: Partial<DcaConfig> = {}
): DcaConfig {
    return {
        ...defaultDcaConfig,
        ...overrides,
        weights: {
            ...defaultDcaConfig.weights,
            ...overrides.weights,
        },
    };
}

export function parseMarketCsv(csv: string): MarketPoint[] {
    const lines = csv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (lines.length < 2) {
        throw new Error("CSV 至少需要表头和一行数据");
    }

    const headers = splitCsvLine(lines[0]).map(normalizeHeader);
    const rows = lines.slice(1).map((line, lineIndex) => {
        const cells = splitCsvLine(line);
        const row = new Map<string, string>();
        headers.forEach((header, index) => row.set(header, cells[index] ?? ""));

        const date = readText(row, ["date", "日期"]);
        const close = readNumber(row, ["close", "adjclose", "adj_close", "price", "净值", "收盘价"]);

        if (!date) {
            throw new Error(`第 ${lineIndex + 2} 行缺少 date`);
        }
        if (close === undefined || close <= 0) {
            throw new Error(`第 ${lineIndex + 2} 行 close 必须为正数`);
        }

        return {
            date,
            close,
            earningsYield: readRatio(row, ["earningsyield", "ey", "profityield", "盈利收益率"]),
            riskFreeYield: readRatio(row, ["riskfreeyield", "treasuryyield", "10yyield", "无风险收益率", "十年期国债收益率"]),
            revenueGrowth: readRatio(row, ["revenuegrowth", "revgrowth", "收入增长率"]),
            marginTrend: readRatio(row, ["margintrend", "profitmargintrend", "marginchange", "利润率趋势"]),
            sectorMomentum: readRatio(row, ["sectormomentum", "industrymomentum", "行业动量"]),
            industryScore: readScore(row, ["industryscore", "行业评分"]),
        };
    });

    return rows.sort((a, b) => parseDate(a.date).getTime() - parseDate(b.date).getTime());
}

export function calculateDcaDecision(
    point: MarketPoint,
    context: TrailingContext,
    config: DcaConfig = defaultDcaConfig
): DcaDecision {
    const valueScore = point.earningsYield === undefined || point.riskFreeYield === undefined
        ? 0
        : clamp(((point.earningsYield - point.riskFreeYield) - config.requiredSpread) / config.spreadBand, -1, 1);

    const drawdownScore = context.movingAverageDiscount === undefined
        ? 0
        : clamp(context.movingAverageDiscount / config.movingAverageBand, -1, 1);

    const industryScore = calculateIndustryScore(point, config);

    const rateScore = point.riskFreeYield === undefined
        ? 0
        : clamp((point.riskFreeYield - config.highRateThreshold) / config.rateBand, -1, 1);

    const volatilityScore = context.trailingVolatility === undefined
        ? 0
        : clamp((context.trailingVolatility - config.volatilityThreshold) / config.volatilityBand, 0, 1);

    const rawMultiplier = 1
        + config.weights.value * valueScore
        + config.weights.drawdown * drawdownScore
        + config.weights.industry * industryScore
        - config.weights.rate * rateScore
        - config.weights.volatility * volatilityScore;

    const multiplier = clamp(rawMultiplier, config.minMultiplier, config.maxMultiplier);

    return {
        date: point.date,
        baseContribution: config.baseContribution,
        targetContribution: roundCurrency(config.baseContribution * multiplier),
        multiplier,
        scores: {
            value: valueScore,
            drawdown: drawdownScore,
            industry: industryScore,
            rate: rateScore,
            volatility: volatilityScore,
        },
        rationale: buildRationale(valueScore, drawdownScore, industryScore, rateScore, volatilityScore),
    };
}

export function runBacktest(
    points: MarketPoint[],
    overrides: Partial<DcaConfig> = {}
): BacktestResult {
    if (points.length === 0) {
        throw new Error("回测数据不能为空");
    }

    const config = mergeDcaConfig(overrides);
    let fixedShares = 0;
    let dynamicShares = 0;
    let dynamicCash = 0;
    let fixedInvested = 0;
    let dynamicInvested = 0;
    let totalContributed = 0;
    let multiplierSum = 0;
    const rows: BacktestRow[] = [];

    points.forEach((point, index) => {
        if (index > 0) {
            const annualCashYield = point.riskFreeYield ?? config.cashYieldFallback;
            dynamicCash *= 1 + annualCashYield / 12;
        }

        const context = buildTrailingContext(points, index);
        const decision = calculateDcaDecision(point, context, config);
        dynamicCash += config.baseContribution;
        totalContributed += config.baseContribution;

        const fixedContribution = config.baseContribution;
        const targetDynamicContribution = decision.targetContribution;
        const dynamicContribution = Math.min(targetDynamicContribution, dynamicCash);

        fixedShares += fixedContribution / point.close;
        fixedInvested += fixedContribution;
        dynamicShares += dynamicContribution / point.close;
        dynamicInvested += dynamicContribution;
        dynamicCash -= dynamicContribution;
        multiplierSum += decision.multiplier;

        rows.push({
            date: point.date,
            close: point.close,
            fixedContribution: roundCurrency(fixedContribution),
            dynamicContribution: roundCurrency(dynamicContribution),
            targetDynamicContribution: roundCurrency(targetDynamicContribution),
            fixedValue: roundCurrency(fixedShares * point.close),
            dynamicValue: roundCurrency(dynamicShares * point.close + dynamicCash),
            dynamicCash: roundCurrency(dynamicCash),
            dynamicMultiplier: decision.multiplier,
        });
    });

    const lastPoint = points[points.length - 1];
    const fixedFinalValue = fixedShares * lastPoint.close;
    const dynamicFinalValue = dynamicShares * lastPoint.close + dynamicCash;
    const latestDecision = calculateDcaDecision(
        lastPoint,
        buildTrailingContext(points, points.length - 1),
        config
    );

    return {
        config,
        latestDecision,
        summary: {
            months: points.length,
            totalContributed: roundCurrency(totalContributed),
            fixedInvested: roundCurrency(fixedInvested),
            dynamicInvested: roundCurrency(dynamicInvested),
            dynamicEndingCash: roundCurrency(dynamicCash),
            fixedFinalValue: roundCurrency(fixedFinalValue),
            dynamicFinalValue: roundCurrency(dynamicFinalValue),
            fixedTotalReturn: fixedFinalValue / totalContributed - 1,
            dynamicTotalReturn: dynamicFinalValue / totalContributed - 1,
            fixedXirr: calculateXirr(buildCashFlows(points, config.baseContribution, fixedFinalValue)),
            dynamicXirr: calculateXirr(buildCashFlows(points, config.baseContribution, dynamicFinalValue)),
            fixedMaxDrawdown: calculateMaxDrawdown(rows.map((row) => row.fixedValue)),
            dynamicMaxDrawdown: calculateMaxDrawdown(rows.map((row) => row.dynamicValue)),
            averageDynamicMultiplier: multiplierSum / points.length,
        },
        rows,
    };
}

function calculateIndustryScore(point: MarketPoint, config: DcaConfig): number {
    if (point.industryScore !== undefined) {
        return clamp(point.industryScore, -1, 1);
    }

    const scores: number[] = [];
    if (point.revenueGrowth !== undefined) {
        scores.push(clamp((point.revenueGrowth - config.revenueGrowthTarget) / config.revenueGrowthTarget, -1, 1));
    }
    if (point.marginTrend !== undefined) {
        scores.push(clamp(point.marginTrend / config.marginTrendBand, -1, 1));
    }
    if (point.sectorMomentum !== undefined) {
        scores.push(clamp(point.sectorMomentum / config.sectorMomentumBand, -1, 1));
    }

    if (scores.length === 0) {
        return 0;
    }

    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function buildTrailingContext(points: MarketPoint[], index: number): TrailingContext {
    const from = Math.max(0, index - 11);
    const window = points.slice(from, index + 1);
    const movingAverage = window.reduce((sum, point) => sum + point.close, 0) / window.length;
    const movingAverageDiscount = (movingAverage - points[index].close) / movingAverage;

    const returns = window.slice(1).map((point, returnIndex) => point.close / window[returnIndex].close - 1);
    const trailingVolatility = returns.length >= 2 ? annualizedVolatility(returns) : undefined;

    return {
        movingAverageDiscount,
        trailingVolatility,
    };
}

function buildCashFlows(
    points: MarketPoint[],
    monthlyContribution: number,
    finalValue: number
): Array<{ date: Date; amount: number }> {
    const cashFlows = points.map((point) => ({
        date: parseDate(point.date),
        amount: -monthlyContribution,
    }));
    cashFlows.push({
        date: parseDate(points[points.length - 1].date),
        amount: finalValue,
    });
    return cashFlows;
}

function calculateXirr(cashFlows: Array<{ date: Date; amount: number }>): number | undefined {
    const hasPositive = cashFlows.some((flow) => flow.amount > 0);
    const hasNegative = cashFlows.some((flow) => flow.amount < 0);
    if (!hasPositive || !hasNegative) {
        return undefined;
    }

    let low = -0.9999;
    let high = 1;
    let lowValue = npv(cashFlows, low);
    let highValue = npv(cashFlows, high);

    while (lowValue * highValue > 0 && high < 100) {
        high *= 2;
        highValue = npv(cashFlows, high);
    }

    if (lowValue * highValue > 0) {
        return undefined;
    }

    for (let i = 0; i < 100; i++) {
        const mid = (low + high) / 2;
        const midValue = npv(cashFlows, mid);
        if (Math.abs(midValue) < 0.000001) {
            return mid;
        }
        if (lowValue * midValue <= 0) {
            high = mid;
            highValue = midValue;
        } else {
            low = mid;
            lowValue = midValue;
        }
    }

    return (low + high) / 2;
}

function npv(cashFlows: Array<{ date: Date; amount: number }>, rate: number): number {
    const start = cashFlows[0].date.getTime();
    return cashFlows.reduce((sum, flow) => {
        const years = (flow.date.getTime() - start) / YEAR_MS;
        return sum + flow.amount / Math.pow(1 + rate, years);
    }, 0);
}

function calculateMaxDrawdown(values: number[]): number {
    let peak = values[0];
    let maxDrawdown = 0;

    values.forEach((value) => {
        peak = Math.max(peak, value);
        maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
    });

    return maxDrawdown;
}

function annualizedVolatility(returns: number[]): number {
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(12);
}

function buildRationale(
    valueScore: number,
    drawdownScore: number,
    industryScore: number,
    rateScore: number,
    volatilityScore: number
): string[] {
    return [
        describeScore(valueScore, "盈利收益率相对无风险利率有安全边际", "盈利收益率安全边际不足"),
        describeScore(drawdownScore, "价格低于均线，偏逆向加仓", "价格高于均线，控制追高"),
        describeScore(industryScore, "行业增长/利润率/动量较强", "行业基本面信号偏弱"),
        describeScore(-rateScore, "利率压力较低", "利率压力较高"),
        describeScore(-volatilityScore, "波动处于可接受区间", "波动偏高，降低投入强度"),
    ];
}

function describeScore(score: number, positive: string, negative: string): string {
    if (score > 0.15) {
        return positive;
    }
    if (score < -0.15) {
        return negative;
    }
    return "信号中性";
}

function splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];
        if (char === '"' && next === '"') {
            current += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
            cells.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }

    cells.push(current.trim());
    return cells;
}

function normalizeHeader(header: string): string {
    return header.trim().replace(/\s|-/g, "").toLowerCase();
}

function readText(row: Map<string, string>, keys: string[]): string | undefined {
    for (const key of keys.map(normalizeHeader)) {
        const value = row.get(key);
        if (value) {
            return value;
        }
    }
    return undefined;
}

function readNumber(row: Map<string, string>, keys: string[]): number | undefined {
    const text = readText(row, keys);
    if (text === undefined) {
        return undefined;
    }

    const parsed = Number(text.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
}

function readRatio(row: Map<string, string>, keys: string[]): number | undefined {
    const text = readText(row, keys);
    if (text === undefined) {
        return undefined;
    }

    return parseRatio(text);
}

function readScore(row: Map<string, string>, keys: string[]): number | undefined {
    const ratio = readRatio(row, keys);
    return ratio === undefined ? undefined : clamp(ratio, -1, 1);
}

function parseRatio(text: string): number | undefined {
    const normalized = text.trim();
    if (normalized.length === 0) {
        return undefined;
    }

    const isPercent = normalized.endsWith("%");
    const parsed = Number(normalized.replace("%", "").replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
        return undefined;
    }

    if (isPercent || Math.abs(parsed) > 1) {
        return parsed / 100;
    }
    return parsed;
}

function parseDate(date: string): Date {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`日期格式无效：${date}`);
    }
    return parsed;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function roundCurrency(value: number): number {
    return Math.round(value * 100) / 100;
}
