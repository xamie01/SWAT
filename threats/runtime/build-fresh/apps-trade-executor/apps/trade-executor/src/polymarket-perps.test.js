import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePerpsMarginHealth, calculateApproxLiquidationPrice, executePerpsOrder, openAttributedPerpsSession } from './polymarket-perps.js';
import { OrderSide, PerpsTimeInForce } from '@polymarket/client';
// Mock DB queries
vi.mock('@swat/db', () => ({
    upsertPerpsInstrument: vi.fn(),
    upsertPerpsAccount: vi.fn(),
    upsertPerpsPosition: vi.fn(),
    recordPerpsOrder: vi.fn().mockResolvedValue({ id: 'test-order-uuid' }),
    getPerpsInstrumentBySymbol: vi.fn(),
    getPerpsInstruments: vi.fn()
}));
describe('Polymarket Perps Infrastructure', () => {
    describe('evaluatePerpsMarginHealth', () => {
        it('approves a healthy account with low margin ratio', () => {
            const portfolio = {
                margin: {
                    totalAccountValue: '1000',
                    totalInitialMargin: '200',
                    totalMaintenanceMargin: '100',
                    totalPositionValue: '200'
                },
                withdrawable: '800',
                inLiquidation: false
            };
            const result = evaluatePerpsMarginHealth(portfolio);
            expect(result.safe).toBe(true);
            expect(result.marginRatio).toBe(0.1);
            expect(result.availableMargin).toBe(800);
        });
        it('rejects an account actively in liquidation', () => {
            const portfolio = {
                margin: {
                    totalAccountValue: '200',
                    totalInitialMargin: '180',
                    totalMaintenanceMargin: '180',
                    totalPositionValue: '180'
                },
                withdrawable: '0',
                inLiquidation: true
            };
            const result = evaluatePerpsMarginHealth(portfolio);
            expect(result.safe).toBe(false);
            expect(result.inLiquidation).toBe(true);
            expect(result.reason).toContain('in liquidation');
        });
        it('rejects an account exceeding 85% maintenance margin threshold', () => {
            const portfolio = {
                margin: {
                    totalAccountValue: '1000',
                    totalInitialMargin: '900',
                    totalMaintenanceMargin: '880',
                    totalPositionValue: '900'
                },
                withdrawable: '50',
                inLiquidation: false
            };
            const result = evaluatePerpsMarginHealth(portfolio);
            expect(result.safe).toBe(false);
            expect(result.marginRatio).toBe(0.88);
            expect(result.reason).toContain('Critical margin utilization');
        });
        it('rejects a depleted account with zero account value', () => {
            const portfolio = {
                margin: {
                    totalAccountValue: '0',
                    totalInitialMargin: '0',
                    totalMaintenanceMargin: '0',
                    totalPositionValue: '0'
                },
                withdrawable: '0',
                inLiquidation: false
            };
            const result = evaluatePerpsMarginHealth(portfolio);
            expect(result.safe).toBe(false);
            expect(result.reason).toContain('depleted or zero');
        });
    });
    describe('calculateApproxLiquidationPrice', () => {
        it('returns 0 for unleveraged 1x position', () => {
            const liq = calculateApproxLiquidationPrice(OrderSide.BUY, 65000, 1);
            expect(liq).toBe('0');
        });
        it('calculates long liquidation price correctly for 10x leverage', () => {
            // 65000 * (1 - 1/10 + 0.05) = 65000 * 0.95 = 61750
            const liq = calculateApproxLiquidationPrice(OrderSide.BUY, 65000, 10, 0.05);
            expect(liq).toBe('61750.00');
        });
        it('calculates short liquidation price correctly for 10x leverage', () => {
            // 65000 * (1 + 1/10 - 0.05) = 65000 * 1.05 = 68250
            const liq = calculateApproxLiquidationPrice(OrderSide.SELL, 65000, 10, 0.05);
            expect(liq).toBe('68250.00');
        });
    });
    describe('openAttributedPerpsSession', () => {
        it('opens session with builder label', async () => {
            const mockSession = {};
            const mockClient = {
                openPerpsSession: vi.fn().mockResolvedValue(mockSession)
            };
            const builder = '0x1234567890123456789012345678901234567890';
            const session = await openAttributedPerpsSession(mockClient, builder);
            expect(mockClient.openPerpsSession).toHaveBeenCalledWith({
                label: 'swat-builder-0x12345678'
            });
            expect(session).toBe(mockSession);
        });
    });
    describe('executePerpsOrder', () => {
        let mockSession;
        beforeEach(() => {
            mockSession = {
                fetchPortfolio: vi.fn().mockResolvedValue({
                    margin: {
                        totalAccountValue: '5000',
                        totalInitialMargin: '1000',
                        totalMaintenanceMargin: '500',
                        totalPositionValue: '1000'
                    },
                    withdrawable: '3000',
                    inLiquidation: false
                }),
                placeOrder: vi.fn().mockResolvedValue({
                    order: {
                        id: 12345,
                        price: '65000',
                        quantity: '0.1',
                        filledQuantity: '0.1',
                        status: 'filled',
                        clientOrderId: 'test-client-id'
                    }
                })
            };
        });
        it('rejects order when margin required exceeds available margin', async () => {
            // 0.1 BTC at $65000 with 1x leverage = $6500 required margin, but only $3000 available
            await expect(executePerpsOrder({
                userId: 'user-1',
                session: mockSession,
                instrumentId: 1,
                symbol: 'BTC-PERP',
                side: OrderSide.BUY,
                quantity: '0.1',
                price: '65000',
                leverage: 1
            })).rejects.toThrow('Perps Margin Insufficient');
        });
        it('successfully places and records order with 5x leverage and take-profit/stop-loss', async () => {
            // 0.1 BTC at $65000 with 5x leverage = $1300 required margin, well within $3000 available
            const result = await executePerpsOrder({
                userId: 'user-1',
                session: mockSession,
                instrumentId: 1,
                symbol: 'BTC-PERP',
                side: OrderSide.BUY,
                quantity: '0.1',
                price: '65000',
                leverage: 5,
                takeProfitPrice: '70000',
                stopLossPrice: '62000',
                timeInForce: PerpsTimeInForce.IOC
            });
            expect(mockSession.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
                instrumentId: 1,
                side: OrderSide.BUY,
                quantity: '0.1',
                price: '65000',
                timeInForce: PerpsTimeInForce.IOC,
                takeProfit: { triggerPrice: '70000' },
                stopLoss: { triggerPrice: '62000' }
            }));
            expect(result.orderId).toBe(12345);
            expect(result.status).toBe('filled');
        });
    });
});
//# sourceMappingURL=polymarket-perps.test.js.map