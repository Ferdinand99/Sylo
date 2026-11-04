import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Meta from '../components/Meta.jsx';
import CopyButton from '../components/CopyButton.jsx';
import { cardTitle, channelTitle, hostOf, minutesAsText } from '../util.js';

vi.mock('../notify.js', () => ({ notify: vi.fn() }));

describe('Meta', () => {
  it('separates the facts with a dot that screen readers skip, and none after the last', () => {
    const { container } = render(
      <p>
        <Meta items={['Level 3', false, '1,200 XP', 'by alice']} />
      </p>
    );
    const items = container.querySelectorAll('.v2-meta-item');
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('.v2-meta-sep')).not.toBeNull();
    expect(items[1].querySelector('.v2-meta-sep')).not.toBeNull();
    expect(items[2].querySelector('.v2-meta-sep')).toBeNull();
    expect(items[0].querySelector('.v2-meta-sep').getAttribute('aria-hidden')).toBe('true');
  });

  it('lets only a long fact wrap inside itself', () => {
    const long = 'a reason a moderator typed that goes on and on for a while';
    const { container } = render(
      <p>
        <Meta items={['by alice', long]} />
      </p>
    );
    const items = container.querySelectorAll('.v2-meta-item');
    expect(items[0].className).not.toContain('is-long');
    expect(items[1].className).toContain('is-long');
  });
});

describe('card titles', () => {
  it('uses the content, and the old generic title while the card is empty', () => {
    expect(cardTitle('  ninja  ', 'New streamer')).toBe('ninja');
    expect(cardTitle('', 'New streamer')).toBe('New streamer');
    expect(cardTitle('   ', 'New streamer')).toBe('New streamer');
    expect(cardTitle(undefined, 'Board')).toBe('Board');
  });

  it('cuts a very long title', () => {
    const t = cardTitle('x'.repeat(200), 'Board', 20);
    expect([...t].length).toBe(20);
    expect(t.endsWith('…')).toBe(true);
  });

  it('names a channel by its id', () => {
    const channels = [{ id: '1', name: 'general' }];
    expect(channelTitle(channels, '1', 'Sticky')).toBe('#general');
    expect(channelTitle(channels, '', 'Sticky')).toBe('Sticky');
    expect(channelTitle(channels, '9', 'Sticky')).toBe('Sticky');
  });

  it('takes the host of a feed address', () => {
    expect(hostOf('https://www.example.com/feed.xml', 'Feed')).toBe('example.com');
    expect(hostOf('http://blog.example.org/rss', 'Feed')).toBe('blog.example.org');
    expect(hostOf('not a url', 'Feed')).toBe('Feed');
    expect(hostOf('javascript:alert(1)', 'Feed')).toBe('Feed');
    expect(hostOf('', 'Feed')).toBe('Feed');
  });
});

describe('minutesAsText', () => {
  it('reads a long number of minutes as hours and days', () => {
    expect(minutesAsText(1440)).toBe('24 hours');
    expect(minutesAsText(60)).toBe('1 hour');
    expect(minutesAsText(90)).toBe('1 hour 30 minutes');
    expect(minutesAsText(2880)).toBe('2 days');
    expect(minutesAsText(3000)).toBe('2 days 2 hours');
    expect(minutesAsText(1500)).toBe('25 hours');
  });

  it('says nothing for a short or invalid number', () => {
    expect(minutesAsText(0)).toBe('');
    expect(minutesAsText(45)).toBe('');
    expect(minutesAsText('')).toBe('');
    expect(minutesAsText(-5)).toBe('');
  });
});

describe('CopyButton', () => {
  it('copies the value and says so', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton text="123456789" what="user ID" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy user ID' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('123456789');
  });
});
