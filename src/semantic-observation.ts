import { z } from 'zod';

const SEMANTIC_IMPACT_FACTOR_DIRECTIONS = ['support', 'block', 'unclear'] as const;

export const SEMANTIC_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_OBSERVATION_MAX_FACTORS = 20 as const;
export const SEMANTIC_OBSERVATION_MAX_EVIDENCE_PER_ITEM = 20 as const;

const stableIdSchema = z.string().trim().min(1).max(191);
const semanticTextSchema = z.string().trim().min(1).max(1_000);
const semanticTextListSchema = z
  .array(semanticTextSchema)
  .max(20)
  .superRefine((items, context) => {
    if (new Set(items).size !== items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Semantic text entries must be unique.',
      });
    }
  });

export const semanticModelEvidenceRefV1Schema = z
  .object({
    sourceKind: z.enum(['message', 'note']),
    sourceId: stableIdSchema,
  })
  .strict();

export type SemanticModelEvidenceRefV1 = z.infer<typeof semanticModelEvidenceRefV1Schema>;

const semanticModelEvidenceListV1Schema = z
  .array(semanticModelEvidenceRefV1Schema)
  .min(1)
  .max(SEMANTIC_OBSERVATION_MAX_EVIDENCE_PER_ITEM)
  .superRefine((items, context) => {
    const identities = items.map(semanticEvidenceIdentity);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Semantic evidence references must be unique within one item.',
      });
    }
  });

export const semanticObservationFactorV1Schema = z
  .object({
    direction: z.enum(SEMANTIC_IMPACT_FACTOR_DIRECTIONS),
    claim: semanticTextSchema,
    evidence: semanticModelEvidenceListV1Schema,
  })
  .strict();

export type SemanticObservationFactorV1 = z.infer<typeof semanticObservationFactorV1Schema>;

export const semanticObservationContradictionV1Schema = z
  .object({
    summary: semanticTextSchema,
    evidence: semanticModelEvidenceListV1Schema,
  })
  .strict();

export type SemanticObservationContradictionV1 = z.infer<
  typeof semanticObservationContradictionV1Schema
>;

const semanticObservationShape = {
  summary: semanticTextSchema,
  factors: z.array(semanticObservationFactorV1Schema).max(SEMANTIC_OBSERVATION_MAX_FACTORS),
  missingInformation: semanticTextListSchema,
  contradictions: z
    .array(semanticObservationContradictionV1Schema)
    .max(SEMANTIC_OBSERVATION_MAX_FACTORS),
} as const;

/** Model-authored map result. It deliberately has no impact, tendency, subscore or system metadata. */
export const semanticObservationV1Schema = z.object(semanticObservationShape).strict();
export type SemanticObservationV1 = z.infer<typeof semanticObservationV1Schema>;


function semanticEvidenceIdentity(reference: SemanticModelEvidenceRefV1): string {
  return `${reference.sourceKind}\u0000${reference.sourceId}`;
}
