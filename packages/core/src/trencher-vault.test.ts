import assert from "node:assert/strict";
import { test } from "node:test";
import { ParamCondition } from "@zerodev/permissions/policies";
import { CASH } from "./tokens";
import { GRANT_TRENCHER, grantTrencher, trencherPermissions } from "./trencher-vault";
import { buildCallPermissions, buildWallPolicies } from "./wall";
import { firstEnableEnvelope, wallShape } from "./first-enable-gas";
const self = "0x1111111111111111111111111111111111111111";
const opts = {trencherVaultAddress:"0x2222222222222222222222222222222222222222",trencherFactoryAddress:"0x3333333333333333333333333333333333333333"};
test("autonomous permission is explicit and cannot grant recovery or arbitrary approvals",()=>{
  assert.deepEqual(trencherPermissions({},self,5_000_000n),[]);
  assert.equal(grantTrencher(opts),null);
  assert.ok(grantTrencher({...opts,grantFeatures:[GRANT_TRENCHER]}));
  const permissions=trencherPermissions(opts,self,10_000_000n);
  assert.deepEqual(permissions.map(p=>p.functionName),["approve","buy","sell","deploy"]);
  assert.equal(permissions[0]!.target,CASH.USDG);
  assert.deepEqual(permissions[0]!.args[1],{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:5_000_000n});
  assert.deepEqual(permissions[3]!.args[0],{condition:ParamCondition.EQUAL,value:self});
  const wall=buildCallPermissions({perTradeUsdg:3,dailyUsdg:20,maxOpsPerDay:10,maxDrawdownBps:500,expiryDays:7} as never,self,opts);
  const buy=wall.find(p=>p.functionName==="buy" && p.target===opts.trencherVaultAddress);
  assert.ok(buy); assert.deepEqual(buy.args?.[3],{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:3_000_000n});
});
test("incomplete or malformed custody permissions fail closed",()=>{
  for(const bad of [{trencherVaultAddress:opts.trencherVaultAddress},{...opts,trencherFactoryAddress:"0x"},{...opts,trencherVaultAddress:"0x"+"0".repeat(40)},{...opts,trencherFactoryAddress:opts.trencherVaultAddress}]) {
    assert.throws(()=>trencherPermissions(bad,self,5_000_000n));
    assert.equal(grantTrencher({...bad,grantFeatures:[GRANT_TRENCHER]}),null);
  }
});
test("the autonomous wall serializes and fits the existing first-enable bound alongside the class vault",()=>{
  const caps={perTradeUsdg:10,dailyUsdg:500,maxOpsPerDay:24,maxDrawdownPct:5,expiryDays:7};
  const scope={...opts,ponsClassVaultAddress:"0x4444444444444444444444444444444444444444",ponsClassVaultFactoryAddress:"0x5555555555555555555555555555555555555555"};
  const shape=wallShape(buildCallPermissions(caps,self,scope));
  assert.equal(firstEnableEnvelope(shape).withinHardMax,true);
  assert.doesNotThrow(()=>buildWallPolicies({caps,smartAccount:self,...scope}));
});
