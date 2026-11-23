import { z } from "zod";
import { ProjectAccessLevel } from "./projects.ts";
import { Timestamp } from "./common.ts";








export const AgentKeyValidity = z
  .enum(["7", "14", "30", "60", "90", "never"])
  .meta({ id: "AgentKeyValidity" });
export type AgentKeyValidity = z.infer<typeof AgentKeyValidity>;




export const AgentKeyEventType = z
  .enum(["agent_key_created", "agent_key_revoked", "agent_key_rotated"])
  .meta({ id: "AgentKeyEventType" });
export type AgentKeyEventType = z.infer<typeof AgentKeyEventType>;

export const Agent = z
  .object({
    id: z.string(),
    humanId: z.string(),
    name: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: "Agent" });
export type Agent = z.infer<typeof Agent>;

export const AgentsResponse = z.object({ agents: z.array(Agent) }).meta({ id: "AgentsResponse" });
export type AgentsResponse = z.infer<typeof AgentsResponse>;

export const CreateAgentRequest = z
  .object({ name: z.string().trim().min(1).max(120) })
  .meta({ id: "CreateAgentRequest" });
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;



export const AgentKeyProject = z
  .object({ projectId: z.string(), projectName: z.string(), level: ProjectAccessLevel })
  .meta({ id: "AgentKeyProject" });
export type AgentKeyProject = z.infer<typeof AgentKeyProject>;

export const AgentKey = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    workspaceId: z.string(),
    createdByHumanId: z.string(),
    validity: AgentKeyValidity,
    keyHint: z.string().nullable(),
    createdAt: Timestamp,
    expiresAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    revokedByHumanId: z.string().nullable(),
    
    
    replacesKeyId: z.string().nullable(),
    projects: z.array(AgentKeyProject),
  })
  .meta({ id: "AgentKey" });
export type AgentKey = z.infer<typeof AgentKey>;

export const AgentKeysResponse = z
  .object({ keys: z.array(AgentKey) })
  .meta({ id: "AgentKeysResponse" });
export type AgentKeysResponse = z.infer<typeof AgentKeysResponse>;



export const AgentKeyGrant = z
  .object({ projectId: z.string(), level: ProjectAccessLevel })
  .meta({ id: "AgentKeyGrant" });
export type AgentKeyGrant = z.infer<typeof AgentKeyGrant>;

export const AgentKeyGrants = z
  .array(AgentKeyGrant)
  .refine(
    (grants) => new Set(grants.map((grant) => grant.projectId)).size === grants.length,
    "Grant each project at most once.",
  );
export type AgentKeyGrants = z.infer<typeof AgentKeyGrants>;

export const CreateAgentKeyRequest = z
  .object({
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    
    
    validity: AgentKeyValidity.default("90"),
    projects: AgentKeyGrants,
  })
  .meta({ id: "CreateAgentKeyRequest" });
export type CreateAgentKeyRequest = z.infer<typeof CreateAgentKeyRequest>;





export const RotateAgentKeyRequest = z
  .object({
    validity: AgentKeyValidity.optional(),
    projects: AgentKeyGrants.optional(),
  })
  .meta({ id: "RotateAgentKeyRequest" });
export type RotateAgentKeyRequest = z.infer<typeof RotateAgentKeyRequest>;




export const CreateAgentKeyResponse = z
  .object({ key: AgentKey, secret: z.string() })
  .meta({ id: "CreateAgentKeyResponse" });
export type CreateAgentKeyResponse = z.infer<typeof CreateAgentKeyResponse>;





export const AgentIdentity = z
  .object({
    agentId: z.string(),
    name: z.string(),
    humanId: z.string(),
    keyId: z.string(),
    workspaceId: z.string(),
    validity: AgentKeyValidity,
    projects: z.array(AgentKeyProject),
  })
  .meta({ id: "AgentIdentity" });
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const AgentIdentityQuery = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .meta({ id: "AgentIdentityQuery" });
export type AgentIdentityQuery = z.infer<typeof AgentIdentityQuery>;
