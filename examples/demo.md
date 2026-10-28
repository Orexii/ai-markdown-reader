---
title: Reader demonstration
---

# A reader that understands structure

Ordinary prose should flow naturally. **Emphasis**, `inline identifiers`, and
[useful links](https://example.com/a/very/long/address) should not sound like Markdown syntax.
Technical names are spoken the way people say them: the ANF team ships `DataHarborConfig` to AKS
VMs, tracks work in ADO and IcM, and runs `npm run build` before v1.2.3 goes out at 10:30.

## Bullet points

- **First point:** the label belongs to the sentence, not to the formatting.
- This item has a second paragraph.

  Continue the same thought without announcing another bullet.
  - Nested detail: keep its place in the parent item.
  - Another detail with *emphasis*.
- [x] A completed task.
- [ ] An outstanding task.

## Ordered steps

3. Begin with step three.
4. Continue with step four.

## Tables

| Service | State | Next action |
| :--- | :---: | --- |
| Mail | Ready | Send the **draft** |
| Search | Waiting | Rebuild the index |
| Notes | | Keep the escaped pipe: A \| B |

> [!TIP]
> Click any word to read from there, or switch tables to column-by-column reading in the settings.

## Quotation and code

> A quotation is read as a quotation.

```typescript
const answer = 42;
console.log(answer);
```

By default, the reader announces code blocks instead of speaking punctuation.
