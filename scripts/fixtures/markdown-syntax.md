# ATX 一级标题
## ATX 二级标题
### ATX 三级标题
#### ATX 四级标题
##### ATX 五级标题
###### ATX 六级标题

Setext 一级标题
===============

Setext 二级标题
---------------

普通段落：Inkstone Markdown syntax smoke test，中英文混排。

软换行前行
软换行后行仍属同段。

硬换行前行  
硬换行后行应另起一行。

反斜杠换行前行\
反斜杠换行后行应另起一行。

星号斜体：*italic-star 星斜*
下划线斜体：_italic-underline 下斜_
星号粗体：**bold-star 星粗**
下划线粗体：__bold-underline 下粗__
三星粗斜体：***bold-italic-star 粗斜***
三下划线粗斜体：___bold-italic-underline 下粗斜___
删除线：~~strike-text 删除~~
单波浪线：~single-tilde 不删除~
粗体嵌套斜体：**outer-bold 内有 *inner-em 斜体* 结束**
斜体嵌套粗体：*outer-em 内有 **inner-bold 粗体** 结束*
单词内下划线：snake_case_name 必须保持普通文本。
转义字符：\*literal-stars 不斜体\*、\_literal-underscore 不斜体\_、\# 不是标题。
字符实体：&amp; &lt; &gt; &quot; &#39; 应正确解码。
行内代码：`inline-code *not-em* <tag>` 保持等宽与字面内容。
多反引号代码：``code-with-`backtick`` 应保留单个反引号。

[内联链接](https://example.com/inline "内联链接标题") 与 [引用链接][reference-target]。
自动链接：<https://example.com/autolink>。
GFM 裸链接：https://example.com/literal-link 。
链接引用定义稍后给出，[折叠引用][] 也应可用。

![内嵌图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= "像素图片标题")

![0.75](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= "旧版缩放图片")

行内图片：![行内图像](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= "行内图片标题") 与文字共存。

![引用式图片][pixel-reference]

> 引用第一行，包含 *quote-em 斜体*。
>
> 引用第二段。
>
> > 嵌套引用内容。

- 无序短横线一
- 无序短横线二
  - 嵌套无序子项

* 无序星号项

+ 无序加号项

1. 有序列表一
2. 有序列表二
   1. 嵌套有序子项

有序列表分段说明，下面的列表应从四开始。

4. 从四开始的有序项
5. 下一项应为五

- [ ] 未完成任务
- [x] 已完成任务，含 **task-bold 粗体**

```javascript
const fenceToken = "*fence-not-em* <div>";
console.log(fenceToken);
```

~~~python
tilde_fence = "波浪代码块"
print(tilde_fence)
~~~

    indented_code = "缩进代码块"
    print(indented_code)

thematic-break-短横线

---

thematic-break-星号

***

thematic-break-下划线

___

| 左对齐表头 | 居中对齐表头 | 右对齐表头 |
| :--------- | :----------: | ---------: |
| 左单元格 | 中单元格 | 右单元格 |
| **表格粗体** | *表格斜体* | `表格代码` |

行内公式：$E=mc^2$，公式前后文字应保留。

$$
\frac{a}{b}+\sqrt{c}=displayMathToken
$$

行内 HTML：before <span data-test="inline-html">inline-html-text</span> after。

<div data-test="block-html">
block-html-text
</div>

[reference-target]: https://example.com/reference "引用链接标题"
[折叠引用]: https://example.com/collapsed
[pixel-reference]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= "引用图片标题"
