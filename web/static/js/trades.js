$(function() {
  const tradesTable = $('#tradesTable').DataTable({
    bFilter: false,
    paging: false,
    info: false,
    serverSide: true,
    ajax: {
      type: 'GET',
      url: '/trades/positions'
    },
    columns: [
      { data: 'position.side', title: 'Side' },
      { data: 'exchange', title: 'Exchange' },
      { data: 'position.symbol', title: 'Symbol' },
      { data: 'position.amount', title: 'Amount' },
      { data: 'currency', title: 'Currency' },
      { data: 'position.profit', title: 'Profit', defaultContent: '' },
      { data: 'position.entry', title: 'Entry' },
      { data: 'position.updatedAt', title: 'UpdatedAt' },
      { data: 'position.createdAt', title: 'CreatedAt' },
      { data: 'actions', title: 'Actions' }
    ],
    order: [[1, 'desc']],
    columnDefs: [
      {
        targets: 0,
        render: $.fn.dataTable.render.arrows()
      },
      {
        targets: 2,
        render: $.fn.dataTable.render.tradingviewLink('exchange')
      },
      {
        targets: 3,
        render: $.fn.dataTable.render.greenRed({ minimumFractionDigits: 2 })
      },
      {
        targets: [4, 6],
        render: $.fn.dataTable.render.number('', '.', 2)
      },
      {
        targets: 5,
        render: $.fn.dataTable.render.greenRed({ style: 'percent', minimumFractionDigits: 2 })
      },
      {
        targets: [7, 8],
        render: $.fn.dataTable.render.moment('YYYY-MM-DDTHH:mm:ss.SSSZ', 'YYYY-MM-DD HH:mm:ss') // 2020-05-21T20:38:11.462Z
      },
      {
        targets: 9,
        render: $.fn.dataTable.render.actionButtons()
      }
    ]
  });

  // bind button actions
  $('#tradesTable tbody').on('click', 'button', function() {
    const data = tradesTable.row($(this).parents('tr')).data();
    $.get(`/pairs/${data.exchange}/${data.position.symbol}/${this.value}`);
  });

  const ordersTable = $('#ordersTable').DataTable({
    bFilter: false,
    paging: false,
    info: false,
    serverSide: true,
    ajax: {
      type: 'GET',
      url: '/trades/orders'
    },
    columns: [
      { data: 'order.side', title: 'Side' },
      { data: 'exchange', title: 'Exchange' },
      { data: 'order.symbol', title: 'Symbol' },
      { data: 'order.amount', title: 'Amount' },
      { data: 'order.price', title: 'Price' },
      { data: 'order.type', title: 'Type' },
      { data: 'order.id', title: 'ID' },
      { data: 'order.retry', title: 'Retry' },
      { data: 'order.ourId', title: 'OurId' },
      { data: 'order.createdAt', title: 'CreatedAt' },
      { data: 'order.updatedAt', title: 'UpdatedAt' },
      { data: 'order.status', title: 'Status' },
      { data: 'actions', title: 'Actions' }
    ],
    order: [[1, 'desc']],
    columnDefs: [
      {
        targets: 0,
        render: $.fn.dataTable.render.arrows()
      },
      {
        targets: 2,
        render: $.fn.dataTable.render.tradingviewLink('exchange')
      },
      {
        targets: 3,
        render: $.fn.dataTable.render.greenRed({ minimumFractionDigits: 2 })
      },
      {
        targets: 4,
        render: $.fn.dataTable.render.number('', '.', 2)
      },
      {
        targets: [9, 10],
        render: $.fn.dataTable.render.moment('YYYY-MM-DDTHH:mm:ss.SSSZ', 'YYYY-MM-DD HH:mm:ss') // 2020-05-21T20:38:11.462Z
      },
      {
        targets: 12,
        render: $.fn.dataTable.render.actionButtons()
      }
    ]
  });

  // bind button actions
  $('#ordersTable tbody').on('click', 'button', function() {
    const data = ordersTable.row($(this).parents('tr')).data();
    $.ajax({
      url: `/orders/${data.exchange}/${data.order.id}`,
      type: 'DELETE',
      success: function(result) {
        ordersTable.ajax.reload();
      }
    });
  });
});
