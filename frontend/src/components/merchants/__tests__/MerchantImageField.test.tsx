import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import MerchantImageField from '../MerchantImageField';

// A picture the server refuses was taken, and its upload failed after the merchant was
// saved ("Merchant created but image upload failed"). It is refused beside the button.
describe('MerchantImageField', () => {
  it("says beside the picker why a file wasn't taken, and chooses the next one", async () => {
    const choose = vi.fn();
    const user = userEvent.setup({ applyAccept: false });
    render(<Theme><MerchantImageField upload={{ preview: null, choose, remove: vi.fn() }} /></Theme>);
    const button = screen.getByRole('button', { name: 'Upload merchant image' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The file dialog offers the four types the server takes, as My Profile's does, not image/*.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp');
    await user.upload(input, new File(['svg'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(button).toHaveAccessibleDescription('Choose a JPEG, PNG, GIF or WebP image.');
    await user.upload(input, new File(['jpg'], 'logo.jfif', { type: 'image/jpeg' }));
    expect(button).toHaveAccessibleDescription(/^A picture named \.jfif isn't taken/);
    expect(choose).not.toHaveBeenCalled();

    const logo = new File(['png'], 'logo.png', { type: 'image/png' });
    await user.upload(input, logo);
    expect(choose).toHaveBeenCalledWith(logo);
    expect(screen.queryByText(/isn't taken/)).not.toBeInTheDocument();
  });

  it("sits the preview's remove button on the image's corner, 8px out", () => {
    render(
      <Theme>
        <MerchantImageField upload={{ preview: 'data:image/png;base64,AAAA', choose: vi.fn(), remove: vi.fn() }} />
      </Theme>,
    );
    const corner = screen.getByRole('button', { name: 'Remove image' }).parentElement as HTMLElement;
    // Radix has no negative inset classes: top="-2" set nothing, and the button sat below the image.
    expect(corner.className).toMatch(/(?:^|\s)rt-r-top(?:\s|$)/);
    expect(corner.style.getPropertyValue('--top')).toBe('-8px');
    expect(corner.className).toMatch(/(?:^|\s)rt-r-right(?:\s|$)/);
    expect(corner.style.getPropertyValue('--right')).toBe('-8px');
  });
});
