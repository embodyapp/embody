/** Holds the claiming-suites advisory lock; resolves to its release function. */
export function holdClaimLock(connectionString: string): Promise<() => Promise<void>>;
