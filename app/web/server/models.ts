import type { Gender, Position } from "../shared/catalog.ts";

export type { Gender, Position };

export interface Volunteer {
  id: number;
  name: string;
  gender: Gender;
  team: string;
  active: boolean;
  can_bercario: boolean;
  can_cozinha: boolean;
  can_recepcao: boolean;
  can_banheiro: boolean;
  can_limpar_altar: boolean;
  observation: string;
}

export interface Assignment {
  position_code: string;
  position_name: string;
  category: string;
  volunteer_id: number;
  volunteer_name: string;
  order: number;
}

export interface GenerationResult {
  assignments: Assignment[];
  warnings: string[];
}

export interface Issue {
  codes: string[];
  message: string;
}

/** Contagens de histórico de um voluntário (rotatividade). */
export interface HistoryStats {
  counts: Record<string, number>;
  position_counts: Record<string, number>;
  total: number;
}

export interface HistoryContext {
  stats: Map<number, HistoryStats>;
  last_reception_ids: Set<number>;
  last_map_ids: Set<number>;
  last_positions: Map<number, Set<string>>;
  last_altar_gender: string | null;
}

export function emptyHistory(over: Partial<HistoryContext> = {}): HistoryContext {
  return {
    stats: new Map(),
    last_reception_ids: new Set(),
    last_map_ids: new Set(),
    last_positions: new Map(),
    last_altar_gender: null,
    ...over,
  };
}
