import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { objectStoreContract } from "./storage.contract.ts";
import { createS3ObjectStore } from "./storage.ts";

const ACCESS_KEY = "orrerytestaccesskey";
const SECRET_KEY = "orrerytestsecretkey";
const REGION = "us-east-1";
const BUCKET = `orrery-contract-${randomUUID().slice(0, 8)}`;

let container: StartedTestContainer;
let endpoint: string;
let client: S3Client;

beforeAll(async () => {
  container = await new GenericContainer("rustfs/rustfs:latest")
    .withEnvironment({ RUSTFS_ACCESS_KEY: ACCESS_KEY, RUSTFS_SECRET_KEY: SECRET_KEY })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/health", 9000).forStatusCode(200))
    .start();
  endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  client = new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 120_000);

afterAll(async () => {
  client?.destroy();
  await container?.stop();
}, 30_000);

objectStoreContract(async () => ({
  store: createS3ObjectStore({
    endpoint,
    bucket: BUCKET,
    region: REGION,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
  }),
  // Simulate an operator's `aws s3 sync`: write/read bytes straight at the key,
  // bypassing the adapter under test.
  writeRaw: async (key, data) => {
    await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: data }));
  },
  readRaw: async (key) => {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return response.Body === undefined
      ? null
      : Buffer.from(await response.Body.transformToByteArray());
  },
}));

const missingBucketStore = () =>
  createS3ObjectStore({
    endpoint,
    bucket: `missing-${BUCKET}`,
    region: REGION,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    forcePathStyle: true,
  });

describe("S3ObjectStore health", () => {
  it("reports an unreachable bucket as unhealthy", async () => {
    expect(await missingBucketStore().checkHealth()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/S3 bucket/i),
    });
  });

  it("throws on a missing bucket instead of reporting a missing key", async () => {
    const store = missingBucketStore();
    const key = `contract/${randomUUID()}.bin`;
    await expect(store.get(key)).rejects.toThrow(/bucket/i);
    await expect(store.delete(key)).rejects.toThrow(/bucket/i);
  });
});
