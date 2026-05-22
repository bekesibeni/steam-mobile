export enum ETradeOfferState {
  Invalid = 1,
  Active = 2,
  Accepted = 3,
  Countered = 4,
  Expired = 5,
  Canceled = 6,
  Declined = 7,
  InvalidItems = 8,
  CreatedNeedsConfirmation = 9,
  CanceledBySecondFactor = 10,
  InEscrow = 11,
  /** Trade was reverted by the user (Trade protection update 2025) */
  Reverted = 12,
}

export enum ETradeStatus {
  Init = 0,
  PreCommitted = 1,
  Committed = 2,
  Complete = 3,
  Failed = 4,
  PartialSupportRollback = 5,
  FullSupportRollback = 6,
  SupportRollback_Selective = 7,
  RollbackFailed = 8,
  RollbackAbandoned = 9,
  InEscrow = 10,
  EscrowRollback = 11,
  /** Trade was reverted by the user (Trade protection update 2025) */
  Reverted = 12,
}

export enum EConfirmationMethod {
  None = 0,
  Email = 1,
  MobileApp = 2,
}

export enum EOfferFilter {
  ActiveOnly = 1,
  HistoricalOnly = 2,
  All = 3,
}

export enum EResult {
  Invalid = 0,
  OK = 1,
  Fail = 2,
  AccessDenied = 15,
  Timeout = 16,
  Banned = 17,
  ServiceUnavailable = 20,
  Pending = 22,
  LimitExceeded = 25,
  Expired = 27,
  Revoked = 26,
  RateLimitExceeded = 84,
  TwoFactorCodeMismatch = 88,
  LimitedUserAccount = 112,
}
