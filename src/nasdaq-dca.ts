import { readFileSync } from "fs";
import { resolve } from "path";
import {
    BacktestResult,
    DcaDecision,
    parseMarketCsv,
    runBacktest,
} from "./nasdaqDca.js";

interface CliOptions {
    csvPath: string;
    baseContribution: number;
    json: boolean;
}

const DEFAULT_CSV = "examples/nasdaq-dca-sample.csv";

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const csv = readFileSync(resolve(process.cwd(), options.csvPath), "utf8");
    const points = parseMarketCsv(csv);
    const result = runBacktest(points, {
        baseContribution: options.baseContribution,
    });

    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    printReport(result);
}

function parseArgs(args: string[]): CliOptions {
    const options: CliOptions = {
        csvPath: DEFAULT_CSV,
        baseContribution: 1000,
        json: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--csv") {
            options.csvPath = requireValue(args, ++i, "--csv");
        } else if (arg === "--base") {
            options.baseContribution = Number(requireValue(args, ++i, "--base"));
            if (!Number.isFinite(options.baseContribution) || options.baseContribution <= 0) {
                throw new Error("--base 必须是正数");
            }
        } else if (arg === "--json") {
            options.json = true;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`未知参数：${arg}`);
        }
    }

    return options;
}

function requireValue(args: string[], index: number, flag: string): string {
    const value = args[index];
    if (!value) {
        throw new Error(`${flag} 缺少参数值`);
    }
    return value;
}

function printReport(result: BacktestResult): void {
    const { summary, latestDecision } = result;
    const recentRows = result.rows.slice(-6);

    console.log("纳指基金动态定投量化回测");
    console.log("================================");
    console.log("说明：该工具用于形成纪律化定投流程，不构成投资建议。真实决策应使用基金净值、费率、税费和个人风险承受能力复核。");
    console.log("");
    console.log("最新一期建议");
    console.log(`- 日期：${latestDecision.date}`);
    console.log(`- 基础定投：${formatMoney(latestDecision.baseContribution)}`);
    console.log(`- 量化倍数：${latestDecision.multiplier.toFixed(2)}x`);
    console.log(`- 目标定投：${formatMoney(latestDecision.targetContribution)}`);
    console.log(`- 依据：${dedupe(latestDecision.rationale).join("；")}`);
    console.log("");
    console.log("回测摘要");
    console.log(`- 月数：${summary.months}`);
    console.log(`- 外部累计投入预算：${formatMoney(summary.totalContributed)}`);
    console.log(`- 固定定投期末资产：${formatMoney(summary.fixedFinalValue)}，总收益率：${formatPercent(summary.fixedTotalReturn)}，XIRR：${formatOptionalPercent(summary.fixedXirr)}，最大回撤：${formatPercent(summary.fixedMaxDrawdown)}`);
    console.log(`- 动态定投期末资产：${formatMoney(summary.dynamicFinalValue)}，总收益率：${formatPercent(summary.dynamicTotalReturn)}，XIRR：${formatOptionalPercent(summary.dynamicXirr)}，最大回撤：${formatPercent(summary.dynamicMaxDrawdown)}`);
    console.log(`- 动态实际买入：${formatMoney(summary.dynamicInvested)}，期末现金储备：${formatMoney(summary.dynamicEndingCash)}，平均倍数：${summary.averageDynamicMultiplier.toFixed(2)}x`);
    console.log("");
    console.log("最近 6 期执行明细");
    console.log("日期         收盘/净值    固定买入    动态买入    动态资产    现金储备    倍数");
    recentRows.forEach((row) => {
        console.log([
            row.date.padEnd(12),
            row.close.toFixed(2).padStart(9),
            formatMoney(row.fixedContribution).padStart(10),
            formatMoney(row.dynamicContribution).padStart(10),
            formatMoney(row.dynamicValue).padStart(10),
            formatMoney(row.dynamicCash).padStart(10),
            `${row.dynamicMultiplier.toFixed(2)}x`.padStart(6),
        ].join("  "));
    });
}

function printHelp(): void {
    console.log(`用法：
  npm run nasdaq:dca -- --csv <file> --base <amount>

参数：
  --csv   输入 CSV，默认 ${DEFAULT_CSV}
  --base  每月基础定投金额，默认 1000
  --json  输出完整 JSON 结果

CSV 必需列：date, close
可选列：earningsYield, riskFreeYield, revenueGrowth, marginTrend, sectorMomentum, industryScore`);
}

function formatMoney(value: number): string {
    return value.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

function formatOptionalPercent(value: number | undefined): string {
    return value === undefined ? "N/A" : formatPercent(value);
}

function dedupe(values: string[]): string[] {
    return Array.from(new Set(values));
}

try {
    main();
} catch (err) {
    if (err instanceof Error) {
        console.error(err.message);
    } else {
        console.error(err);
    }
    process.exit(1);
}
