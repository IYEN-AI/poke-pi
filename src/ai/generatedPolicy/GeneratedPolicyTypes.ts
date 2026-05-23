import { z } from "zod";
import { HarnessActionSchema } from "../../control/ActionSchema.js";

const ButtonDirectionSchema = z.enum(["up", "right", "down", "left"]);
const GeneratedPolicyExplorationStrategySchema = z.enum(["greedy-map-direction", "bold-route-probe"]);

export const GeneratedPolicyConditionSchema = z.strictObject({
  battle: z.boolean().optional(),
  textActive: z.boolean().optional(),
  screenTextKind: z.string().optional(),
  mapId: z.number().int().optional(),
  route: z.string().optional(),
  y: z.number().int().optional(),
  x: z.number().int().optional(),
  sameCoordRepeatsGte: z.number().int().min(0).optional(),
  facingInteractionCandidate: z.boolean().optional()
});

export const GeneratedPolicyRuleSchema = z.strictObject({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  when: GeneratedPolicyConditionSchema,
  action: HarnessActionSchema.optional(),
  preferMapDirection: z.boolean().optional(),
  explorationStrategy: GeneratedPolicyExplorationStrategySchema.optional(),
  confidence: z.number().min(0).max(1).default(0.6)
}).refine((rule) => rule.action !== undefined || rule.preferMapDirection === true || rule.explorationStrategy !== undefined, {
  message: "rule must provide action, preferMapDirection, or explorationStrategy"
});

export const GeneratedPolicyTuningSchema = z.strictObject({
  avoidRecentDirections: z.boolean().default(true),
  preferDifferentBlock: z.boolean().default(true),
  interactionCandidatePatience: z.number().int().min(0).max(20).default(2),
  fallbackToBaseHeuristic: z.boolean().default(true),
  boldProbeAfterRepeats: z.number().int().min(1).max(20).default(3)
});

export const GeneratedPolicySchema = z.strictObject({
  schema: z.literal("pokemon-generated-policy.v1"),
  id: z.string().min(1).max(120),
  createdAt: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  objective: z.string().min(1).max(500),
  base: z.literal("map-heuristic"),
  tuning: GeneratedPolicyTuningSchema.default({ avoidRecentDirections: true, preferDifferentBlock: true, interactionCandidatePatience: 2, fallbackToBaseHeuristic: true, boldProbeAfterRepeats: 3 }),
  rules: z.array(GeneratedPolicyRuleSchema).min(1).max(50),
  notes: z.array(z.string().max(300)).max(20).default([])
});

export type GeneratedPolicyCondition = z.infer<typeof GeneratedPolicyConditionSchema>;
export type GeneratedPolicyRule = z.infer<typeof GeneratedPolicyRuleSchema>;
export type GeneratedPolicyDefinition = z.infer<typeof GeneratedPolicySchema>;
export type GeneratedPolicyTuning = z.infer<typeof GeneratedPolicyTuningSchema>;
export type GeneratedPolicyDirection = z.infer<typeof ButtonDirectionSchema>;
