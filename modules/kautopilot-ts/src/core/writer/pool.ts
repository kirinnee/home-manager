// ============================================================================
// Writer account pool — kloop-style weighted map of claude wrapper binaries on
// PATH (`claude-auto-<name>`; each owns its own CLAUDE_CONFIG_DIR). Consulted
// only when a phase's writer session doesn't exist yet, and on rebootstrap
// (excluding the failed account when alternatives exist). (spec §2)
// ============================================================================

/**
 * Weighted random pick from the pool. `exclude` drops named accounts first
 * (rebootstrap: never re-pick the account that just failed) — but when
 * exclusion would empty the pool, the full pool is used (a single-account pool
 * has nothing better to offer; the caller surfaces that in its remediation).
 * `rand` is injectable for deterministic tests.
 */
export function pickAccount(
	pool: Record<string, number>,
	exclude: string[] = [],
	rand: () => number = Math.random,
): string {
	let entries = Object.entries(pool).filter(([, w]) => w > 0);
	if (entries.length === 0) {
		throw new Error("writer.pool is empty — configure at least one account");
	}
	const filtered = entries.filter(([name]) => !exclude.includes(name));
	if (filtered.length > 0) entries = filtered;
	const total = entries.reduce((sum, [, w]) => sum + w, 0);
	let roll = rand() * total;
	for (const [name, weight] of entries) {
		roll -= weight;
		if (roll <= 0) return name;
	}
	return entries[entries.length - 1][0];
}

/** Whether the pool has any account other than `account`. */
export function hasAlternative(
	pool: Record<string, number>,
	account: string,
): boolean {
	return Object.keys(pool).some((name) => name !== account && pool[name] > 0);
}
