-- Make Request.categoryId optional to support ALL_SELLERS requests without category.
ALTER TABLE "Request" ALTER COLUMN "categoryId" DROP NOT NULL;

-- Allow seller to attach an image when accepting a request.
ALTER TABLE "AcceptedRequest" ADD COLUMN IF NOT EXISTS "sellerImageUrl" TEXT;
