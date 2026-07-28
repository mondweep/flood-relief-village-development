import { err, ok, type Result, type SignalId } from "@afrip/shared-kernel";

export type Source =
  | "facebook"
  | "x"
  | "instagram"
  | "youtube"
  | "news"
  | "whatsapp_field_report"
  | "other";

const SOURCES: readonly Source[] = [
  "facebook",
  "x",
  "instagram",
  "youtube",
  "news",
  "whatsapp_field_report",
  "other",
];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

export type ActivityType =
  | "relief_distribution"
  | "medical_camp"
  | "infrastructure_damage"
  | "orphan_identified"
  | "missing_person"
  | "donation"
  | "other";

const ACTIVITY_TYPES: readonly ActivityType[] = [
  "relief_distribution",
  "medical_camp",
  "infrastructure_damage",
  "orphan_identified",
  "missing_person",
  "donation",
  "other",
];

export function isActivityType(value: string): value is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(value);
}

export interface Extracted {
  readonly villageName?: string;
  readonly ngoName?: string;
  readonly activityType?: ActivityType;
  readonly needs: string[];
}

export interface SignalCreateProps {
  id: SignalId;
  source: Source;
  rawText: string;
  extracted: Extracted;
  detectedAt: string;
}

function isIsoTimestamp(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function validateSignalProps(props: SignalCreateProps): string | null {
  if (props.rawText.trim().length === 0) return "rawText must not be empty";
  if (!isSource(props.source)) return `invalid source: ${String(props.source)}`;
  if (props.extracted.activityType !== undefined && !isActivityType(props.extracted.activityType)) {
    return `invalid activityType: ${String(props.extracted.activityType)}`;
  }
  if (!Array.isArray(props.extracted.needs)) return "extracted.needs must be an array";
  for (const need of props.extracted.needs) {
    if (typeof need !== "string" || need.trim().length === 0) {
      return "extracted.needs entries must be non-empty strings";
    }
  }
  if (!isIsoTimestamp(props.detectedAt)) return "detectedAt must be a valid ISO timestamp";
  return null;
}

export class Signal {
  readonly id: SignalId;
  readonly source: Source;
  readonly rawText: string;
  readonly extracted: Extracted;
  readonly detectedAt: string;

  private constructor(props: SignalCreateProps) {
    this.id = props.id;
    this.source = props.source;
    this.rawText = props.rawText;
    this.extracted = {
      villageName: props.extracted.villageName,
      ngoName: props.extracted.ngoName,
      activityType: props.extracted.activityType,
      needs: [...props.extracted.needs],
    };
    this.detectedAt = props.detectedAt;
  }

  static create(props: SignalCreateProps): Result<Signal> {
    const error = validateSignalProps(props);
    if (error) return err(error);
    return ok(new Signal(props));
  }
}
