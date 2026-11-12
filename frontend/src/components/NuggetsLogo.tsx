import React from 'react';
import { Box } from '@radix-ui/themes';

interface NuggetsLogoProps {
  size?: number;
  className?: string;
}

const NuggetsLogo: React.FC<NuggetsLogoProps> = ({ size = 80, className = '' }) => {
  return (
    <Box position="relative" className={`animate-float ${className}`} style={{ width: size, height: size }}>
      <Box
        position="relative" width="100%" height="100%" className="nugget-shape shadow-lg"
        style={{
          background: 'linear-gradient(135deg, #FFD700 0%, #FFA500 50%, #FF8C00 100%)',
          borderRadius: '50% 40% 45% 35%',
          boxShadow: '0 5px 15px rgba(255, 140, 0, 0.3)',
        }}
      >
        {/* Gold highlight */}
        <Box
          position="absolute" className="opacity-70"
          style={{
            top: '10%',
            left: '20%',
            width: '20%',
            height: '20%',
            background: 'linear-gradient(135deg, #FFFF00 0%, #FFD700 100%)',
            borderRadius: '50%'
          }}
        />
        
        {/* Dollar sign */}
        <Box
          position="absolute" className="font-bold"
          style={{
            // The nugget is fixed artwork, the same gold in every theme, so its colours are too
            // (FIXED_ARTWORK in scripts/check-idiom-a.mjs lets them stay inline).
            color: '#78350f',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: size * 0.4,
            textShadow: '1px 1px 2px rgba(0,0,0,0.3)'
          }}
        >
          $
        </Box>
      </Box>
    </Box>
  );
};

export default NuggetsLogo;
