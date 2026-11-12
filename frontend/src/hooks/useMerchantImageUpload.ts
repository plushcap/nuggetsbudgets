import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { uploadMerchantImage, type Merchant } from '../services/api';
import { logger } from '../utils/logger';

export interface MerchantImageUpload {
  /** The chosen image as a data URL, once read, for its preview. */
  preview: string | null;
  /** Keeps the chosen file and reads its preview. */
  choose: (picked: File) => void;
  /** Forgets the chosen image. */
  remove: () => void;
  /**
   * Uploads the chosen image (if any) for a merchant that has just been saved. A failure is
   * logged and shown as `failure`, not thrown: the merchant itself was saved.
   */
  uploadFor: (merchant: Pick<Merchant, 'id' | 'uuid'>, failure: string) => Promise<void>;
}

/** The image the add and edit merchant forms upload after saving the merchant. */
export function useMerchantImageUpload(): MerchantImageUpload {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const choose = (picked: File) => {
    setFile(picked);
    const reader = new FileReader();
    reader.onload = (loaded) => {
      setPreview(loaded.target?.result as string);
    };
    reader.readAsDataURL(picked);
  };

  const remove = () => {
    setFile(null);
    setPreview(null);
  };

  const uploadFor = async (merchant: Pick<Merchant, 'id' | 'uuid'>, failure: string) => {
    if (!file) return;
    try {
      await uploadMerchantImage(merchant.uuid, file);
    } catch (imageError) {
      logger.warn({ err: imageError, merchantId: merchant.id }, 'Failed to upload merchant image');
      toast.error(failure);
    }
  };

  return { preview, choose, remove, uploadFor };
}
