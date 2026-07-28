import { err, ok, type AlertId, type Result, type SignalId } from "@afrip/shared-kernel";

export type AlertType =
  | "new_relief_activity"
  | "duplicate_aid_likely"
  | "no_ngo_assigned"
  | "possible_orphan_identified"
  | "medical_support_needed";

const ALERT_TYPES: readonly AlertType[] = [
  "new_relief_activity",
  "duplicate_aid_likely",
  "no_ngo_assigned",
  "possible_orphan_identified",
  "medical_support_needed",
];

export function isAlertType(value: string): value is AlertType {
  return (ALERT_TYPES as readonly string[]).includes(value);
}

export interface SmartAlertCreateProps {
  id: AlertId;
  type: AlertType;
  signalId: SignalId;
  villageName?: string;
  details: string;
  raisedAt: string;
}

function validateSmartAlertProps(props: SmartAlertCreateProps): string | null {
  if (!isAlertType(props.type)) return `invalid alert type: ${String(props.type)}`;
  if (props.details.trim().length === 0) return "details must not be empty";
  if (props.raisedAt.trim().length === 0 || Number.isNaN(Date.parse(props.raisedAt))) {
    return "raisedAt must be a valid ISO timestamp";
  }
  return null;
}

export class SmartAlert {
  readonly id: AlertId;
  readonly type: AlertType;
  readonly signalId: SignalId;
  readonly villageName?: string;
  readonly details: string;
  readonly raisedAt: string;

  private constructor(props: SmartAlertCreateProps) {
    this.id = props.id;
    this.type = props.type;
    this.signalId = props.signalId;
    this.villageName = props.villageName;
    this.details = props.details;
    this.raisedAt = props.raisedAt;
  }

  static create(props: SmartAlertCreateProps): Result<SmartAlert> {
    const error = validateSmartAlertProps(props);
    if (error) return err(error);
    return ok(new SmartAlert(props));
  }
}
