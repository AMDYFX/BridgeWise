import { Module } from '@nestjs/common';
import { ApiKeyVaultService } from './api-key-vault.service';
import { SecureHttpClientService } from './secure-http-client.service';
import { SecureRequestMiddleware } from './secure-request.middleware';
import { ApiSecurityGuard } from './api-security.guard';
import { RequestSignatureService } from './request-signature/request-signature.service';
import { RequestSignatureGuard } from './request-signature/request-signature.guard';
import { RawBodyMiddleware } from './request-signature/raw-body.middleware';

@Module({
  providers: [
    ApiKeyVaultService,
    SecureHttpClientService,
    SecureRequestMiddleware,
    ApiSecurityGuard,
    RequestSignatureService,
    RequestSignatureGuard,
    RawBodyMiddleware,
  ],
  exports: [
    ApiKeyVaultService,
    SecureHttpClientService,
    SecureRequestMiddleware,
    ApiSecurityGuard,
    RequestSignatureService,
    RequestSignatureGuard,
    RawBodyMiddleware,
  ],
})
export class SecurityModule {}
