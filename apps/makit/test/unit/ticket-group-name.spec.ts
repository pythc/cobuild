import { ticketGroupName } from '../../shared/ticket-workflow';
describe('ticket discussion group name', () => {
  it.each(['P0', 'P1', 'P2', 'P3'])(
    'prefixes the actual %s priority',
    (priority) => {
      expect(ticketGroupName('导出图片缺失', priority)).toBe(
        `【${priority}工单】导出图片缺失`,
      );
    },
  );
  it('does not invent a priority and handles empty or long titles safely', () => {
    expect(ticketGroupName('', '')).toBe('【未定级工单】未命名工单');
    const name = ticketGroupName('😀'.repeat(60), 'P1');
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('😀')).toBe(true);
  });
});
