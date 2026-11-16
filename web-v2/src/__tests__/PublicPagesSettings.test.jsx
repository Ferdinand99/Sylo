import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PublicPagesSettings from '../components/PublicPagesSettings.jsx';
import { AccessProvider } from '../access.jsx';

// the whole suite runs on two busy CPUs in CI: role queries with names are slow in jsdom
configure({ asyncUtilTimeout: 5000 });

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getPublicLook: vi.fn(),
  savePublicLook: vi.fn(),
  uploadPublicLookImage: vi.fn(),
  deletePublicLookImage: vi.fn(),
  refreshPublicLookSplash: vi.fn(),
  getGuildAccess: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const api = await import('../api.js');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const SYLO = { dark: '#38c8f0', light: '#076787' };

const look = (over = {}) => ({
  platform: 'discord',
  accent: '',
  background: 'none',
  backgrounds: ['none', 'upload', 'discord-splash'],
  upload: null,
  splash: { available: false, copied: null },
  effective: { accent: SYLO, fallback: [], note: null, backgroundUrl: null, css: null },
  sylo: { accent: SYLO },
  limits: { maxBytes: 2 * 1024 * 1024, types: ['PNG', 'JPEG', 'WebP'], maxSide: 1920 },
  ...over,
});

function renderSection(level = 'edit') {
  api.getGuildAccess.mockResolvedValue({ level });
  return render(
    <AccessProvider guildId={GUILD}>
      <PublicPagesSettings guildId={GUILD} />
    </AccessProvider>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('Server settings: Public pages', () => {
  it('shows nothing below Edit access, whatever the server answers', async () => {
    // The level is not known for a moment, so the first request may go out; the server refuses it (403).
    api.getPublicLook.mockResolvedValue(look({ accent: '#5865f2' }));
    renderSection('view');
    await waitFor(() => expect(api.getGuildAccess).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Public pages')).toBeNull();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
  });

  it('shows nothing when the server refuses the read', async () => {
    api.getPublicLook.mockRejectedValue(new Error('forbidden'));
    renderSection('edit');
    await waitFor(() => expect(api.getPublicLook).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Public pages')).toBeNull();
  });

  it('starts from what is saved and says what stays Sylo’s', async () => {
    api.getPublicLook.mockResolvedValue(look({ accent: '#5865f2' }));
    renderSection();
    expect(await screen.findByText('Public pages')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Accent colour').value).toBe('#5865f2'));
    expect(
      screen.getByText(
        /the layout,\s+the type, the light and dark themes and the "Powered by Sylo" link stay/
      )
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save public pages' }).disabled).toBe(true);
  });

  it('previews the application form with the accent, and Sylo’s colour where the accent is hard to read', async () => {
    api.getPublicLook.mockResolvedValue(look());
    renderSection();
    const input = await screen.findByLabelText('Accent colour');
    const preview = screen.getByTestId('look-preview');
    expect(preview.style.getPropertyValue('--accent')).toBe(SYLO.dark);

    fireEvent.change(input, { target: { value: '#5865F2' } });
    expect(preview.style.getPropertyValue('--accent')).toBe('#5865f2');
    // the link in the preview uses the text colour made from the accent (4.5:1), not the accent itself
    expect(preview.style.getPropertyValue('--accent-text')).toMatch(/^#[0-9a-f]{6}$/);
    expect(preview.style.getPropertyValue('--accent-text')).not.toBe('#5865f2');
    expect(screen.queryByText(/too hard to read/)).toBeNull();
    expect(screen.getByText('Submit application')).toBeTruthy();
    expect(screen.getByText('Powered by Sylo', { selector: 'p' })).toBeTruthy();

    // a deep blue is hard to read on the dark card (the theme now shown): Sylo's colour, and the note says so
    fireEvent.change(input, { target: { value: '#1a2a6c' } });
    expect(preview.style.getPropertyValue('--accent')).toBe(SYLO.dark);
    expect(
      screen.getByText(/too hard to read on the card in the dark theme, so public pages use Sylo/)
    ).toBeTruthy();

    // the light theme reads it, and the preview follows the theme of the dashboard
    document.documentElement.setAttribute('data-theme', 'light');
    fireEvent.change(input, { target: { value: '#1a2a6d' } });
    expect(preview.style.getPropertyValue('--accent')).toBe('#1a2a6d');
  });

  it('refuses a colour that is not one and keeps the save button off', async () => {
    api.getPublicLook.mockResolvedValue(look());
    renderSection();
    const input = await screen.findByLabelText('Accent colour');
    fireEvent.change(input, { target: { value: 'red' } });
    expect(screen.getByText('Use a colour like #5865f2.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save public pages' }).disabled).toBe(true);
  });

  it('saves the accent and the background', async () => {
    api.getPublicLook.mockResolvedValue(look());
    api.savePublicLook.mockResolvedValue(look({ accent: '#5865f2' }));
    renderSection();
    const input = await screen.findByLabelText('Accent colour');
    fireEvent.change(input, { target: { value: '5865F2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save public pages' }));
    await waitFor(() =>
      expect(api.savePublicLook).toHaveBeenCalledWith(GUILD, { accent: '#5865f2', background: 'none' })
    );
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Public pages saved.', 'info'));
  });

  it('offers the invite background only when the server has one, named for its platform', async () => {
    api.getPublicLook.mockResolvedValue(look({ platform: 'fluxer' }));
    const { unmount } = renderSection();
    const none = await screen.findByRole('option', { name: /Invite background from Fluxer \(not set\)/ });
    expect(none.disabled).toBe(true);
    unmount();

    api.getPublicLook.mockResolvedValue(look({ splash: { available: true, copied: null } }));
    renderSection();
    const option = await screen.findByRole('option', { name: 'Invite background from Discord' });
    expect(option.disabled).toBe(false);
    const select = screen.getByLabelText('Background');
    fireEvent.change(select, { target: { value: 'discord-splash' } });
    expect(screen.getByText(/downloaded when you save/)).toBeTruthy();
    expect(screen.getByText(/visitors never load it from Discord/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check the invite background now' })).toBeTruthy();
  });

  it('uploads a picture, chooses it, and removes it again', async () => {
    api.getPublicLook.mockResolvedValue(look());
    api.uploadPublicLookImage.mockResolvedValue(
      look({ upload: { bytes: 900, url: '/look/123456789012345678.0123456789abcdef.webp', updatedAt: 1 } })
    );
    api.deletePublicLookImage.mockResolvedValue(look());
    const { container } = renderSection();
    await screen.findByText('Public pages');
    const file = new File([new Uint8Array(10)], 'bg.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadPublicLookImage).toHaveBeenCalledWith(GUILD, file));
    await waitFor(() => expect(screen.getByLabelText('Background').value).toBe('upload'));
    const preview = screen.getByTestId('look-preview');
    expect(preview.style.backgroundImage).toContain('/look/123456789012345678.0123456789abcdef.webp');
    // choosing it is still a save
    expect(screen.getByRole('button', { name: 'Save public pages' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    await waitFor(() => expect(api.deletePublicLookImage).toHaveBeenCalledWith(GUILD));
    await waitFor(() => expect(screen.getByLabelText('Background').value).toBe('none'));
  });

  it('does not send a picture larger than 2 MB', async () => {
    api.getPublicLook.mockResolvedValue(look());
    const { container } = renderSection();
    await screen.findByText('Public pages');
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]'), { target: { files: [big] } });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The picture is larger than 2 MB.'));
    expect(api.uploadPublicLookImage).not.toHaveBeenCalled();
  });
});
