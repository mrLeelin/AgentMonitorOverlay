/** A skill found on disk. Discovery alone does not establish whether a runtime has enabled it. */
export interface CatalogSkill {
  name: string;
  description: string;
  /** Absolute, resolved SKILL.md path; suitable for opening in the file viewer. */
  path: string;
  diagnostics: string[];
}

export interface SkillSource {
  id: string;
  name: string;
  root: string;
  exists: boolean;
  skills: CatalogSkill[];
  diagnostics: string[];
}

export interface SkillCatalog {
  scope: "global" | "project";
  workspaceId: string | null;
  sources: SkillSource[];
  notes: string[];
}
