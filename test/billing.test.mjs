import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCodexBilling,checkAccountConfirmation,publicCodexUsage } from '../src/security/billing.mjs';
import { checkClaudeBilling } from '../src/providers/claude.mjs';
import { subscriptionEnvironment } from '../src/security/environment.mjs';
import { checkCodexRoute } from '../src/providers/codex.mjs';

test('Codex accepts its reported official default endpoint and rejects custom routes',()=>{
  const config={model_provider:'openai',chatgpt_base_url:'https://chatgpt.com/backend-api/'};
  assert.equal(checkCodexRoute(config),null);
  assert.ok(checkCodexRoute({...config,chatgpt_base_url:'https://proxy.example/backend-api/'}));
  assert.ok(checkCodexRoute({...config,model_providers:{openai:{base_url:'https://api.example'}}}));
});

const usage=()=>({ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:25,resetsAt:10,windowDurationMins:300},credits:{hasCredits:false,unlimited:false},spendControlReached:false,rateLimitReachedType:null}});
test('Codex only permits positively verified included subscription usage with no credit fallback',()=>{
  const account={type:'chatgpt'};assert.equal(checkCodexBilling(account,usage()),null);
  assert.match(checkCodexBilling({type:'apiKey'},usage()),/API/);
  assert.match(checkCodexBilling(account,{...usage(),ordinaryUsageAllowed:null}),/could not be verified/);
  assert.match(checkCodexBilling(account,{...usage(),ordinaryUsageAllowed:false}),/exhausted/);
  const paid=usage();paid.rateLimits.credits.hasCredits=true;assert.match(checkCodexBilling(account,paid),/credit fallback/);
  const unknown=usage();unknown.rateLimits.credits=null;assert.match(checkCodexBilling(account,unknown),/unknown/);
  const depleted=usage();depleted.rateLimits.primary.usedPercent=100;assert.match(checkCodexBilling(account,depleted),/exhausted/);
});
test('elapsed reset time and unused percentages never infer recovered quota',()=>{
  const u=usage();u.ordinaryUsageAllowed=null;u.rateLimits.primary.resetsAt=1;u.rateLimits.primary.usedPercent=0;assert.notEqual(checkCodexBilling({type:'chatgpt'},u),null);
});
test('all advertised Codex quota buckets must satisfy the billing gate',()=>{
  const u=usage();u.rateLimitsByLimitId={normal:u.rateLimits,other:{...u.rateLimits,credits:{hasCredits:true}}};assert.match(checkCodexBilling({type:'chatgpt'},u),/credit fallback/);
});
test('Claude requires explicit user-disabled extra usage, not an empty credit balance',()=>{
  const auth={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'};
  const u={rate_limits_available:true,rate_limits:{limits:[{percent:20}],extra_usage:{is_enabled:false,user_disabled:true}}};
  assert.equal(checkClaudeBilling(auth,u),null);assert.match(checkClaudeBilling({...auth,authMethod:'console'},u),/Sign in/);
  u.rate_limits.extra_usage.user_disabled=false;assert.match(checkClaudeBilling(auth,u),/temporarily empty/);
  u.rate_limits.extra_usage.user_disabled=true;u.rate_limits.extra_usage.is_enabled=true;assert.match(checkClaudeBilling(auth,u),/could not verify/);
});
test('account confirmation expires and cannot transfer to another account',()=>{
  const c={fingerprint:'account-a',disabled:true,verifiedAt:1000};assert.equal(checkAccountConfirmation(c,'account-a',2000),null);
  assert.match(checkAccountConfirmation(c,'account-b',2000),/Verify/);assert.match(checkAccountConfirmation(c,'account-a',86402000),/Recheck/);
});
test('provider children cannot inherit API credentials, gateways or node injection',()=>{
  const env=subscriptionEnvironment({PATH:'safe',CODEX_HOME:'home',OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',ANTHROPIC_PROFILE:'paid',CURSOR_API_ENDPOINT:'elsewhere',CODEX_AUTH_TOKEN:'secret',NODE_OPTIONS:'--require evil',CLAUDE_CODE_USE_BEDROCK:'1',AWS_SECRET_ACCESS_KEY:'secret'});
  assert.deepEqual(env,{PATH:'safe',CODEX_HOME:'home'});
});
test('public usage omits account identifiers and credit reset identifiers',()=>{
  const result=publicCodexUsage({...usage(),accountId:'private',rateLimitResetCredits:{credits:[{id:'private-reset'}]}});assert.doesNotMatch(JSON.stringify(result),/private/);assert.equal(result.windows[0].usedPercent,25);
});
