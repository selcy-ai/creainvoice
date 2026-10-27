import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/tests/helpers/test-db";
import { resetDatabase, createUser, createOrganization, addMembership } from "../factories";
import { ctxFor } from "@/tests/helpers/context";

let oid: string, uid: string;
beforeAll(async () => {
  await resetDatabase();
  const u = await createUser({ username: "dbg" });
  const o = await createOrganization("Dbg");
  await addMembership(u.id, o.id);
  oid = o.id; uid = u.id;
});

describe("dbg", () => {
  it("ctxFor shape", () => {
    const c = ctxFor(oid, uid);
    console.log("SCOPE:", JSON.stringify(c.scope));
    expect(c.scope.organizationId).toBe(oid);
  });
});
