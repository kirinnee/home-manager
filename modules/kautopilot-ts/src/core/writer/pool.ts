// ============================================================================
// Writer account pool — kloop-style weighted map of claude wrapper binaries on
// PATH (`claude-auto-<name>`; each owns its own CLAUDE_CONFIG_DIR). Consulted
// once per phase, at phase start, to pin the writer's kteam session account
// (kteam owns any later account failover — there is no rebootstrap re-pick). (spec §2)
// ============================================================================

/**
 * Weighted random pick from the pool. `exclude` drops named accounts first —
 * but when exclusion would empty the pool, the full pool is used (a
 * single-account pool has nothing better to offer). `rand` is injectable for
 * deterministic tests. (`exclude` is retained for callers that want to avoid a
 * known-bad account; the relay itself pins once and lets kteam handle failover.)
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
