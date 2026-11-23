import { createWithdrawalService, type WithdrawalServicePorts } from '@swat/db/dist/withdrawal-service.js';
import {
  createProtectedWithdrawalOtp, consumeProtectedWithdrawalOtp,
  type WithdrawalOtpKeyPort, type WithdrawalOtpDeliveryPort, type WithdrawalOtpCapturePort
} from '@swat/db/dist/withdrawal-otp.js';
import {
  readFinancialAccountingAdmission, assertFinancialIdentity, type FinancialReceiptAdmissionPort
} from '@swat/db/dist/withdrawal-owned.js';
import {
  requireFinancial, type FinancialEffectPorts, type WithdrawalIntent, type WithdrawalRequest, type WithdrawalTransaction
} from '@swat/db/dist/withdrawal-contract.js';
import { createDurableFinancialRunner } from '../../../apps/trade-executor/src/reducing-orchestration.js';
import { createOwnedFinancialObserver, assertOwnedFinancialConservation } from './withdrawal-owned-observer.js';

export interface WithdrawalOwnedCompositionPorts {
  readonly application: Pick<WithdrawalServicePorts, 'transaction' | 'lockEligibility' | 'lockFunding'>;
  readonly observer: WithdrawalTransaction;
  readonly otpKey: WithdrawalOtpKeyPort;
  readonly otpDelivery: WithdrawalOtpDeliveryPort;
  readonly otpCapture: WithdrawalOtpCapturePort;
  readonly transfer: Omit<FinancialEffectPorts<WithdrawalIntent>, 'verify'>;
  /** Separate authenticated restricted writer. App never receives its client or receipt write capability. */
  readonly receipts: FinancialReceiptAdmissionPort<WithdrawalIntent>;
}
export const withdrawalOwnedBoundary = Object.freeze({ sourceImplemented: true, runtimeAccepted: false,
  externalCapabilityAccepted: false, productionReady: false, publicExecution: 'refused', package28Acceptance: 'unchanged-and-not-inherited' } as const);

/** No pool/client/label creates authority. Actual protected ports are mandatory; there is no default success path. */
export function createWithdrawalOwnedComposition(ports: WithdrawalOwnedCompositionPorts) {
  requireFinancial(ports?.application && typeof ports.observer === 'function' && ports.observer !== ports.application.transaction
    && ports.transfer && ports.receipts && typeof ports.receipts.verify === 'function' && typeof ports.receipts.admit === 'function',
  'withdrawal-distinct-protected-composition-unavailable');
  const appTransaction: WithdrawalTransaction = (userId,operation) => ports.application.transaction(userId,async client => {
    await assertFinancialIdentity(client,'swat_app');
    return operation(client);
  });
  const observerTransaction: WithdrawalTransaction = (userId,operation) => ports.observer(userId,async client => {
    await assertFinancialIdentity(client,'swat_app');
    return operation(client);
  });
  const service = createWithdrawalService({ ...ports.application, transaction:appTransaction,
    otp: createProtectedWithdrawalOtp({ key:ports.otpKey, delivery:ports.otpDelivery }) });
  const observer = createOwnedFinancialObserver<WithdrawalIntent>(observerTransaction);
  const runner = createDurableFinancialRunner<WithdrawalIntent>({ transaction:appTransaction,
    revalidate:service.revalidate, account:readFinancialAccountingAdmission,
    effects:{ ...ports.transfer, async verify(record,attempt,observation) {
      const receipt = await ports.receipts.verify(record,attempt,observation);
      if (!receipt) return null;
      await ports.receipts.admit(record,attempt,receipt); // must finish durable independent COMMIT before application
      return receipt;
    } } });
  return Object.freeze({
    boundary:withdrawalOwnedBoundary,
    /** Only these admission/status methods may be passed to MeFinancialPorts. */
    application:Object.freeze({requestOtp:service.requestOtp,submit:service.submit,status:service.status}),
    async requestAndConsume(userId: string, request: WithdrawalRequest) {
      const authorization = await service.requestOtp(userId,request);
      requireFinancial(authorization.delivery === 'sent', 'withdrawal-otp-delivery-unconfirmed');
      const admitted = await consumeProtectedWithdrawalOtp(ports.otpCapture,userId,authorization.intent.id,authorization.authorizationId,
        otp => service.submit(userId,{intentId:authorization.intent.id,authorizationId:authorization.authorizationId,otp}));
      const journal = await observer(userId,admitted.id);
      assertOwnedFinancialConservation(journal);
      requireFinancial(journal.record.status === 'queued' && journal.authorization.length === 1
        && journal.authorization[0]?.consumed === true && journal.attempts.length === 0 && journal.applications.length === 0,
      'withdrawal-owned-consumption-not-durable');
      return {record:journal.record,boundary:withdrawalOwnedBoundary};
    },
    /** Private owned qualification worker, never an HTTP/queue/public route. */
    async process(userId: string, intentId: string) {
      await runner.run(userId,intentId);
      const journal = await observer(userId,intentId);
      assertOwnedFinancialConservation(journal);
      return {record:journal.record,boundary:withdrawalOwnedBoundary};
    },
    observe:observer,
    cancelExpired:runner.cancelExpired
  });
}
