// Mock the Resend SDK before requiring the module under test.
const mockSend = jest.fn().mockResolvedValue({ id: 'email_test_1' });
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const { Resend } = require('resend');
const { sendOtpEmail, otpEmailHtml, _resetClient } = require('../src/lib/email');

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.RESEND_API_KEY;
  delete process.env.FROM_EMAIL;
  _resetClient();
});

afterAll(() => { process.env = ORIGINAL_ENV; });

describe('sendOtpEmail', () => {
  it('throws and does not send when RESEND_API_KEY is missing', async () => {
    await expect(sendOtpEmail('user@example.com', '123456')).rejects.toThrow(/not configured/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends via Resend with the code in subject/text/html when configured', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.FROM_EMAIL = 'no-reply@concordxpress.ca';
    _resetClient();

    await sendOtpEmail('user@example.com', '424242');

    expect(Resend).toHaveBeenCalledWith('re_test_123');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0][0];
    expect(payload.to).toBe('user@example.com');
    expect(payload.from).toBe('no-reply@concordxpress.ca');
    expect(payload.subject).toMatch(/verification code/i);
    expect(payload.text).toContain('424242');
    expect(payload.html).toContain('424242');
  });

  it('falls back to the default From address when FROM_EMAIL is unset', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    _resetClient();
    await sendOtpEmail('user@example.com', '111222');
    expect(mockSend.mock.calls[0][0].from).toBe('no-reply@concordexpress.ca');
  });

  it('propagates a send failure to the caller', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    _resetClient();
    mockSend.mockRejectedValueOnce(new Error('Resend 422 domain not verified'));
    await expect(sendOtpEmail('user@example.com', '333444')).rejects.toThrow(/domain not verified/);
  });
});

describe('otpEmailHtml', () => {
  it('embeds the code in the markup', () => {
    expect(otpEmailHtml('987654')).toContain('987654');
  });
});
