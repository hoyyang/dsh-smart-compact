import { describe, expect, it } from 'vitest'
import { redactText } from '../src/redact.ts'

// 本文件全部使用合成数据（张三 / 13800138000 / example.com / 示例公司），
// 不含任何真实个人信息或企业信息（强制脱敏要求同样约束测试样例）。

describe('redactText — mandatory engine-authored text sanitization', () => {
  it('redacts CN mobile numbers with digit boundaries', () => {
    const r = redactText('联系张三 13800138000 确认，备用 2001380013800 不应命中')
    expect(r.text).toContain('【已脱敏:手机号】')
    expect(r.text).not.toContain('13800138000')
    expect(r.redactions).toBe(1)
  })

  it('redacts email addresses', () => {
    const r = redactText('发送到 zhangsan@example.com 即可，抄送 li.si@corp.example.org')
    expect(r.text).not.toContain('zhangsan@example.com')
    expect(r.text).not.toContain('li.si@corp.example.org')
    expect(r.redactions).toBe(2)
    expect(r.labels).toEqual(['邮箱'])
  })

  it('redacts 18-digit national-ID shapes only', () => {
    const r = redactText('证件号 11010119900307425X 已登记；版本号 1.3.199003 不受影响')
    expect(r.text).toContain('【已脱敏:证件号】')
    expect(r.text).toContain('1.3.199003')
    expect(r.redactions).toBe(1)
  })

  it('redacts CN and EN company names by suffix', () => {
    const r = redactText('北京示例科技有限公司与 Acme Inc. 签约，示例集团未命中后缀外的写法')
    expect(r.text).toContain('【已脱敏:企业名】')
    expect(r.text).not.toContain('示例科技有限公司')
    expect(r.text).not.toContain('Acme Inc.')
    expect(r.redactions).toBe(2)
  })

  it('leaves ordinary prose, versions and long numbers untouched', () => {
    const raw = 'v0.5.0 上线：thresholdRatio 0.85，共压缩 931 条记录（约 410598 tokens）'
    const r = redactText(raw)
    expect(r.text).toBe(raw)
    expect(r.redactions).toBe(0)
  })

  it('is idempotent on already-redacted text', () => {
    const once = redactText('联系 13800138000')
    const twice = redactText(once.text)
    expect(twice.redactions).toBe(0)
    expect(twice.text).toBe(once.text)
  })
})
