import { extractDeadline, extractFeatures, extractThreshold, normalizeText, tokenize } from "./features.js";
import { jaccard, rounded } from "./similarity.js";
import type {
  Comparator,
  ContractComparison,
  ContractSpec,
  NormalizedMarket,
  ResolutionCompatibility
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value?: number): value is number {
  return value !== undefined && Number.isFinite(value);
}

function venueThreshold(market: NormalizedMarket): { threshold?: number; comparator?: Comparator } {
  const strikeType = market.structure?.strikeType?.toLowerCase();
  if (strikeType === "greater" && finite(market.structure?.floorStrike)) {
    return { threshold: market.structure.floorStrike, comparator: ">" };
  }
  if (strikeType === "less" && finite(market.structure?.capStrike)) {
    return { threshold: market.structure.capStrike, comparator: "<" };
  }
  return {};
}

export function normalizeResolutionSource(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    const normalized = normalizeText(trimmed);
    return normalized || undefined;
  }
}

function sourceText(market: NormalizedMarket): string {
  return [market.title, market.subtitle ?? "", market.rules ?? ""].join(" ");
}

export function buildContractSpec(market: NormalizedMarket): ContractSpec {
  const features = extractFeatures(market);
  const structuredThreshold = venueThreshold(market);
  const textualThreshold = extractThreshold(sourceText(market));
  const textualDeadline = extractDeadline(sourceText(market));
  const fallbackDeadline = textualDeadline ?? extractDeadline("", market.closeTime);
  const resolutionSource = normalizeResolutionSource(market.resolutionSource);

  const threshold = structuredThreshold.threshold ?? textualThreshold.threshold;
  const comparator = structuredThreshold.comparator ?? textualThreshold.comparator;

  return {
    subjectText: features.subjectText,
    predicateText: normalizeText(market.title),
    fieldSources: {
      ...(threshold !== undefined ? { threshold: structuredThreshold.threshold !== undefined ? "venue" : "text" } : {}),
      ...(comparator !== undefined ? { comparator: structuredThreshold.comparator !== undefined ? "venue" : "text" } : {}),
      ...(fallbackDeadline !== undefined ? { deadline: textualDeadline !== undefined ? "text" : "fallback" } : {}),
      ...(resolutionSource !== undefined ? { resolutionSource: "venue" } : {})
    },
    ...(threshold !== undefined ? { threshold } : {}),
    ...(comparator !== undefined ? { comparator } : {}),
    ...(fallbackDeadline !== undefined ? { deadline: fallbackDeadline } : {}),
    ...(resolutionSource !== undefined ? { resolutionSource } : {}),
    ...(market.structure?.earlyCloseCondition ? { earlyCloseCondition: normalizeText(market.structure.earlyCloseCondition) } : {}),
    ...(market.rules ? { rulesText: normalizeText(market.rules) } : {})
  };
}

function resolutionCompatibility(left?: string, right?: string): ResolutionCompatibility {
  if (!left || !right) return "UNKNOWN";
  return left === right ? "MATCH" : "MISMATCH";
}

function sameDeadline(left?: string, right?: string): boolean | undefined {
  if (!left || !right) return undefined;
  return Math.abs(new Date(left).valueOf() - new Date(right).valueOf()) < DAY_MS;
}

function sameComparatorFamily(left?: Comparator, right?: Comparator): boolean | undefined {
  if (!left || !right) return undefined;
  return (left.startsWith(">") && right.startsWith(">")) || (left.startsWith("<") && right.startsWith("<"));
}

export function compareContracts(left: ContractSpec, right: ContractSpec): ContractComparison {
  const subjectSimilarity = rounded(jaccard(
    left.subjectText.split(" ").filter(Boolean),
    right.subjectText.split(" ").filter(Boolean)
  ));
  const rulesSimilarity = left.rulesText && right.rulesText
    ? rounded(jaccard(tokenize(left.rulesText), tokenize(right.rulesText)))
    : null;
  const resolution = resolutionCompatibility(left.resolutionSource, right.resolutionSource);
  const differences: string[] = [];

  if (left.threshold !== undefined && right.threshold !== undefined && left.threshold !== right.threshold) {
    differences.push(`threshold:${left.threshold}!=${right.threshold}`);
  }

  const comparatorFamily = sameComparatorFamily(left.comparator, right.comparator);
  if (comparatorFamily === false) {
    differences.push(`comparator:${left.comparator}!=${right.comparator}`);
  }

  const deadlineEqual = sameDeadline(left.deadline, right.deadline);
  if (deadlineEqual === false) {
    differences.push(`deadline:${left.deadline}!=${right.deadline}`);
  }

  if (resolution === "MISMATCH") {
    differences.push(`resolution_source:${left.resolutionSource}!=${right.resolutionSource}`);
  }

  if (
    left.earlyCloseCondition &&
    right.earlyCloseCondition &&
    left.earlyCloseCondition !== right.earlyCloseCondition
  ) {
    differences.push("early_close_condition:mismatch");
  }

  return {
    subjectSimilarity,
    rulesSimilarity,
    resolutionCompatibility: resolution,
    differences
  };
}

export function thresholdImplicationDirection(
  left: ContractSpec,
  right: ContractSpec
): "LEFT_IMPLIES_RIGHT" | "RIGHT_IMPLIES_LEFT" | undefined {
  if (
    left.threshold === undefined ||
    right.threshold === undefined ||
    left.threshold === right.threshold ||
    !left.comparator ||
    !right.comparator
  ) return undefined;

  const greaterFamily = left.comparator.startsWith(">") && right.comparator.startsWith(">");
  const lessFamily = left.comparator.startsWith("<") && right.comparator.startsWith("<");
  if (!greaterFamily && !lessFamily) return undefined;

  const leftImpliesRight = greaterFamily
    ? left.threshold > right.threshold
    : left.threshold < right.threshold;
  return leftImpliesRight ? "LEFT_IMPLIES_RIGHT" : "RIGHT_IMPLIES_LEFT";
}

export function timeImplicationDirection(
  left: ContractSpec,
  right: ContractSpec
): "LEFT_IMPLIES_RIGHT" | "RIGHT_IMPLIES_LEFT" | undefined {
  if (!left.deadline || !right.deadline) return undefined;
  const leftTime = new Date(left.deadline).valueOf();
  const rightTime = new Date(right.deadline).valueOf();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || Math.abs(leftTime - rightTime) < DAY_MS) {
    return undefined;
  }
  return leftTime < rightTime ? "LEFT_IMPLIES_RIGHT" : "RIGHT_IMPLIES_LEFT";
}
