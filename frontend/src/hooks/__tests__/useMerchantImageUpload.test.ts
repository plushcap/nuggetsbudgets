import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'react-hot-toast';
import { useMerchantImageUpload } from '../useMerchantImageUpload';
import { uploadMerchantImage } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, uploadMerchantImage: vi.fn() };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const merchant = { id: 1, uuid: 'm-1' };

describe('useMerchantImageUpload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploads nothing when no image was chosen', async () => {
    const { result } = renderHook(() => useMerchantImageUpload());
    await act(() => result.current.uploadFor(merchant, 'failed'));
    expect(uploadMerchantImage).not.toHaveBeenCalled();
  });

  it('previews the chosen image, uploads it for the saved merchant, and forgets it when removed', async () => {
    vi.mocked(uploadMerchantImage).mockResolvedValue({} as Awaited<ReturnType<typeof uploadMerchantImage>>);
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    const { result } = renderHook(() => useMerchantImageUpload());
    act(() => result.current.choose(file));
    await waitFor(() => expect(result.current.preview).toMatch(/^data:image\/png;base64,/));
    await act(() => result.current.uploadFor(merchant, 'failed'));
    expect(uploadMerchantImage).toHaveBeenCalledWith('m-1', file);

    act(() => result.current.remove());
    expect(result.current.preview).toBeNull();
    await act(() => result.current.uploadFor(merchant, 'failed'));
    expect(uploadMerchantImage).toHaveBeenCalledTimes(1);
  });

  // An empty choice (a chooser closed without a file) never reaches it: FilePickerButton calls
  // nothing for one (FilePickerButton.test.tsx). A second choice replaces the first.
  it('uploads the image chosen last', async () => {
    const first = new File(['x'], 'logo.png', { type: 'image/png' });
    const second = new File(['y'], 'logo2.png', { type: 'image/png' });
    const { result } = renderHook(() => useMerchantImageUpload());
    act(() => result.current.choose(first));
    act(() => result.current.choose(second));
    await act(() => result.current.uploadFor(merchant, 'failed'));
    expect(uploadMerchantImage).toHaveBeenCalledWith('m-1', second);
  });

  it('shows a failed upload without throwing: the merchant is saved', async () => {
    vi.mocked(uploadMerchantImage).mockRejectedValue(new Error('Image too large'));
    const { result } = renderHook(() => useMerchantImageUpload());
    act(() => result.current.choose(new File(['x'], 'logo.png', { type: 'image/png' })));
    await act(() => result.current.uploadFor(merchant, 'Merchant created but image upload failed'));
    expect(toast.error).toHaveBeenCalledWith('Merchant created but image upload failed');
  });
});
