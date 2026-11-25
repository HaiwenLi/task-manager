import type { AgentAdapter, CatalogueCost, CatalogueModel } from "../../src/adapters/types.js";

export const entry = (ref: string, cost: CatalogueCost[], extra: Partial<CatalogueModel> = {}): CatalogueModel => {
  const slash = ref.indexOf("/");
  return { ref, providerID: ref.slice(0, slash), id: ref.slice(slash + 1), modelID: ref.slice(slash + 1), variants: [], cost, enabled: true, ...extra };
};
export const FREE: CatalogueModel = entry("plan/m", [{ input: 0, output: 0 }], { variants: ["high"] });
export const PAID: CatalogueModel = entry("zen/p", [{ input: 3, output: 12 }]);
export const UNKNOWN: CatalogueModel = entry("kimi/k", []);
export const DISABLED: CatalogueModel = { ...FREE, enabled: false };
export const CATALOGUE: CatalogueModel[] = [FREE, PAID, UNKNOWN, DISABLED];
/** An adapter with only the two catalogue methods: it has no `prompt`, so nothing can run on it. */
export const adapterOf = (models: CatalogueModel[], defaultRef: string | null = null): AgentAdapter =>
  ({ modelCatalog: async () => models, defaultModelRef: async () => defaultRef } as unknown as AgentAdapter);
