import {
  IsBoolean,
  IsIn,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// The connected identity determines which platform fields are authoritative.
export class ZernioDto {
  @IsIn(['youtube', 'tiktok'])
  platform: 'youtube' | 'tiktok';

  @ValidateIf((p) => p.platform === 'youtube')
  @IsString()
  @MaxLength(100)
  title: string;

  @ValidateIf((p) => p.platform === 'youtube')
  @IsIn(['public', 'private', 'unlisted'])
  visibility: 'public' | 'private' | 'unlisted';

  @ValidateIf((p) => p.platform === 'youtube')
  @IsBoolean()
  madeForKids: boolean;

  @ValidateIf((p) => p.platform === 'youtube')
  @IsBoolean()
  containsSyntheticMedia: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsString()
  privacy_level: string;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsBoolean()
  allow_comment: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsBoolean()
  allow_duet: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsBoolean()
  allow_stitch: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsIn([true])
  content_preview_confirmed: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsIn([true])
  express_consent_given: boolean;

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsIn(['none', 'brand_organic', 'brand_content'])
  commercialContentType: 'none' | 'brand_organic' | 'brand_content';

  @ValidateIf((p) => p.platform === 'tiktok')
  @IsBoolean()
  video_made_with_ai: boolean;
}
